/**
 * ActionDispatcherPlugin — dispatches planned actions with WIP limiting and
 * optimistic state updates.
 *
 * Subscribes to: world.action.dispatch
 * Publishes:     world.action.outcome, world.action.queue_full
 *
 * On receiving a dispatch event:
 *   1. Checks WIP limit; if at capacity, queues action and publishes queue_full
 *   2. Applies optimistic state effects via StateUpdater
 *   3. If action has meta.topic, publishes to that topic and waits for outcome
 *   4. For free/internal (tier_0, no meta.topic) actions: resolves immediately as success
 *   5. Publishes world.action.outcome with result
 *   6. On failure: triggers rollback via StateRollbackRegistry
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { ActionDispatchPayload, ActionOutcomePayload, ActionQueueFullPayload } from "../event-bus/action-events.ts";
import type { WorldState } from "../../lib/types/world-state.ts";
import { TOPICS } from "../event-bus/topics.ts";
import { DispatchQueue } from "../dispatcher/dispatch-queue.ts";
import { OutcomeTracker } from "../dispatcher/outcome-tracker.ts";
import { applyEffects } from "../planner/state-updater.ts";
import { StateRollbackRegistry } from "../planner/state-rollback.ts";
import type { TelemetryService } from "../telemetry/telemetry-service.ts";

export interface ActionDispatcherConfig {
  wipLimit: number;
  /** Timeout in ms before an action is considered failed (default: 30s). */
  defaultTimeoutMs?: number;
}

export class ActionDispatcherPlugin implements Plugin {
  readonly name = "action-dispatcher";
  readonly description = "Dispatches planned actions with WIP limiting and optimistic state updates";
  readonly capabilities = ["action-dispatch", "outcome-tracking", "wip-limiting"];

  private bus!: EventBus;
  private readonly queue: DispatchQueue;
  private readonly outcomes: OutcomeTracker;
  private readonly rollbackRegistry = new StateRollbackRegistry();
  private readonly subscriptionIds: string[] = [];

  /** Current world state — updated optimistically on dispatch. */
  private worldState: WorldState | null = null;

  /** Pending action timeouts: correlationId → timer. */
  private readonly pendingTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly config: ActionDispatcherConfig,
    private readonly telemetry?: TelemetryService,
  ) {
    this.queue = new DispatchQueue({ wipLimit: config.wipLimit });
    this.outcomes = new OutcomeTracker();
  }

  install(bus: EventBus): void {
    this.bus = bus;

    // Subscribe to world state updates to track current state
    const wsId = bus.subscribe(
      TOPICS.WORLD_STATE_UPDATED,
      this.name,
      (msg: BusMessage) => {
        this.worldState = msg.payload as WorldState;
      }
    );
    this.subscriptionIds.push(wsId);

    // Subscribe to dispatch requests
    const dispatchId = bus.subscribe(
      TOPICS.WORLD_ACTION_DISPATCH,
      this.name,
      (msg: BusMessage) => {
        void this.handleDispatch(msg);
      }
    );
    this.subscriptionIds.push(dispatchId);
  }

  uninstall(): void {
    for (const id of this.subscriptionIds) {
      this.bus.unsubscribe(id);
    }
    this.subscriptionIds.length = 0;

    // Clear all pending timeouts
    for (const [, timer] of this.pendingTimeouts) {
      clearTimeout(timer);
    }
    this.pendingTimeouts.clear();
    this.queue.reset();
    this.rollbackRegistry.clearAll();
  }

  /** Expose outcome tracker for introspection. */
  getOutcomes(): OutcomeTracker {
    return this.outcomes;
  }

  /** Expose WIP queue for introspection. */
  getQueue(): DispatchQueue {
    return this.queue;
  }

  /** Inject world state directly (used in tests or by WorldStateCollector). */
  setWorldState(state: WorldState): void {
    this.worldState = state;
  }

  private async handleDispatch(msg: BusMessage): Promise<void> {
    const payload = msg.payload as ActionDispatchPayload;
    const { action, correlationId } = payload;
    const startedAt = Date.now();

    // Telemetry: this action was selected and is entering dispatch.
    // Counted even when queued by WIP — they still get dispatched later.
    this.telemetry?.bump("action", action.id, "dispatched");

    // Try to dispatch immediately; queue if at WIP limit
    const dispatched = this.queue.tryDispatch(action, correlationId, msg.correlationId);

    if (!dispatched) {
      // At capacity — publish queue_full backpressure signal
      const queueFullPayload: ActionQueueFullPayload = {
        type: "queue_full",
        timestamp: Date.now(),
        wipCount: this.queue.activeCount,
        wipLimit: this.config.wipLimit,
        pendingActionId: action.id,
      };
      this.bus.publish(TOPICS.WORLD_ACTION_QUEUE_FULL, {
        id: crypto.randomUUID(),
        correlationId,
        topic: TOPICS.WORLD_ACTION_QUEUE_FULL,
        timestamp: Date.now(),
        payload: queueFullPayload,
      });
      // Action remains in pending queue; will be dispatched when slot opens
      return;
    }

    await this.executeAction(action, correlationId, msg.correlationId, msg.id, startedAt);
  }

  private async executeAction(
    action: import("../planner/types/action.ts").Action,
    correlationId: string,
    parentCorrelationId: string,
    parentMsgId: string,
    startedAt: number
  ): Promise<void> {
    // Apply optimistic state effects
    let rollback: (() => WorldState) | undefined;
    if (this.worldState && action.effects.length > 0) {
      const result = applyEffects(this.worldState, action.effects);
      this.worldState = result.updatedState;
      rollback = result.rollback;
      this.rollbackRegistry.register(correlationId, action.id, result.rollback);
    }

    try {
      // For tier_0 / no-topic actions: resolve immediately as success
      if (!action.meta.topic) {
        await this.completeAction(action, correlationId, parentCorrelationId, startedAt, true);
        return;
      }

      // For fire-and-forget actions: publish to topic then immediately succeed.
      // Use meta.fireAndForget for alerts, ceremony triggers, and other side-effect-only dispatches.
      if (action.meta.fireAndForget) {
        this.bus.publish(action.meta.topic, {
          id: crypto.randomUUID(),
          correlationId,
          parentId: parentMsgId,
          topic: action.meta.topic,
          timestamp: Date.now(),
          payload: {
            actionId: action.id,
            goalId: action.goalId,
            meta: action.meta,
          },
        });
        await this.completeAction(action, correlationId, parentCorrelationId, startedAt, true);
        return;
      }

      // For actions with a dispatch topic, publish and wait for outcome via timeout
      const timeoutMs = action.meta.timeout ?? this.config.defaultTimeoutMs ?? 30_000;

      await new Promise<void>((resolve) => {
        // Set up timeout
        const timer = setTimeout(() => {
          this.pendingTimeouts.delete(correlationId);
          void this.completeAction(
            action,
            correlationId,
            parentCorrelationId,
            startedAt,
            false,
            "Timeout after " + timeoutMs + "ms"
          ).then(resolve);
        }, timeoutMs);
        this.pendingTimeouts.set(correlationId, timer);

        // Publish to action's target topic
        this.bus.publish(action.meta.topic!, {
          id: crypto.randomUUID(),
          correlationId,
          parentId: parentMsgId,
          topic: action.meta.topic!,
          timestamp: Date.now(),
          payload: {
            actionId: action.id,
            goalId: action.goalId,
            meta: action.meta,
          },
        });

        // Subscribe to outcome for this specific correlationId
        const outcomeSubId = this.bus.subscribe(
          TOPICS.WORLD_ACTION_OUTCOME,
          this.name + ".await." + correlationId,
          (outcomeMsg: BusMessage) => {
            const outcome = outcomeMsg.payload as ActionOutcomePayload;
            if (outcome.correlationId !== correlationId) return;

            // Cancel timeout
            const t = this.pendingTimeouts.get(correlationId);
            if (t) {
              clearTimeout(t);
              this.pendingTimeouts.delete(correlationId);
            }
            this.bus.unsubscribe(outcomeSubId);

            void this.completeAction(
              action,
              correlationId,
              parentCorrelationId,
              startedAt,
              outcome.success,
              outcome.error
            ).then(resolve);
          }
        );
      });
    } catch (err) {
      await this.completeAction(
        action,
        correlationId,
        parentCorrelationId,
        startedAt,
        false,
        String(err)
      );
    }
  }

  private async completeAction(
    action: import("../planner/types/action.ts").Action,
    correlationId: string,
    parentCorrelationId: string,
    startedAt: number,
    success: boolean,
    error?: string
  ): Promise<void> {
    const completedAt = Date.now();

    if (!success) {
      // Roll back optimistic state update
      const restored = this.rollbackRegistry.rollback(correlationId);
      if (restored) {
        this.worldState = restored;
      }
    } else {
      this.rollbackRegistry.commit(correlationId);
    }

    // Record outcome
    const status: "success" | "failure" | "timeout" = success
      ? "success"
      : (error?.includes("Timeout") ? "timeout" : "failure");
    this.outcomes.record({
      correlationId,
      actionId: action.id,
      goalId: action.goalId,
      status,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      error,
    });
    this.telemetry?.bump("action", action.id, status);

    // Publish outcome event
    const outcomePayload: ActionOutcomePayload = {
      type: "outcome",
      actionId: action.id,
      goalId: action.goalId,
      correlationId,
      timestamp: completedAt,
      success,
      error,
      durationMs: completedAt - startedAt,
    };

    this.bus.publish(TOPICS.WORLD_ACTION_OUTCOME, {
      id: crypto.randomUUID(),
      correlationId: parentCorrelationId,
      topic: TOPICS.WORLD_ACTION_OUTCOME,
      timestamp: completedAt,
      payload: outcomePayload,
    });

    // Close the outcome → state feedback loop: re-publish world.state so goals
    // re-evaluate immediately instead of waiting for the next domain poll (60s).
    // Prevents duplicate dispatches for the same violation that was just remediated.
    if (success && action.effects && action.effects.length > 0) {
      this.bus.publish("world.state.updated", {
        id: crypto.randomUUID(),
        correlationId: parentCorrelationId,
        topic: "world.state.updated",
        timestamp: completedAt,
        payload: this.worldState,
      });
    }

    // Complete in WIP queue and dispatch next if available
    const next = this.queue.complete(correlationId);
    if (next) {
      await this.executeAction(next.action, next.correlationId, next.parentCorrelationId, crypto.randomUUID(), next.enqueuedAt);
    }
  }
}
