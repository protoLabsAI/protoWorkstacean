/**
 * ActionDispatcherPlugin — dispatches planned actions with WIP limiting and
 * optimistic state updates.
 *
 * Subscribes to: world.action.dispatch
 * Publishes:     agent.skill.request, autonomous.outcome.goap.{skill}, world.action.queue_full
 *
 * On receiving a dispatch event:
 *   1. Checks WIP limit; if at capacity, queues action and publishes queue_full
 *   2. Applies optimistic state effects via StateUpdater
 *   3. Publishes to agent.skill.request with source.interface='cron',
 *      payload.meta.systemActor='goap', and reply.topic=`agent.skill.response.${correlationId}`
 *   4. Publishes autonomous.outcome.goap.{skill} with the unified outcome payload
 *   6. On failure: triggers rollback via StateRollbackRegistry
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { ActionDispatchPayload, ActionQueueFullPayload } from "../event-bus/action-events.ts";
import type { AutonomousOutcomePayload } from "../event-bus/payloads.ts";
import type { AgentSkillResponsePayload } from "../event-bus/payloads.ts";
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
      // Tier-0 actions with no dispatch intent are pure state effects — their
      // effects were already applied above. Complete immediately.
      // Actions that declare fireAndForget fall through to the dispatch path
      // below so they actually publish to agent.skill.request.
      if (action.tier === "tier_0" && !action.meta.fireAndForget) {
        await this.completeAction(action, correlationId, parentCorrelationId, startedAt, true);
        return;
      }

      // For fire-and-forget actions: publish to agent.skill.request then immediately succeed.
      // Use meta.fireAndForget for alerts, ceremony triggers, and other side-effect-only dispatches.
      if (action.meta.fireAndForget) {
        this.bus.publish(TOPICS.AGENT_SKILL_REQUEST, {
          id: crypto.randomUUID(),
          correlationId,
          parentId: parentMsgId,
          topic: TOPICS.AGENT_SKILL_REQUEST,
          timestamp: Date.now(),
          source: { interface: "cron" },
          payload: {
            skill: action.meta.skillHint ?? action.id,
            content: this._describeDispatch(action),
            goalId: action.goalId,
            meta: { ...action.meta, systemActor: "goap", actionId: action.id, goalId: action.goalId },
          },
        });
        await this.completeAction(action, correlationId, parentCorrelationId, startedAt, true);
        return;
      }

      // For actions with a dispatch topic, publish to agent.skill.request and wait for skill response
      const timeoutMs = action.meta.timeout ?? this.config.defaultTimeoutMs ?? 30_000;
      const replyTopic = `agent.skill.response.${correlationId}`;

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

        // Publish to unified skill dispatch topic
        this.bus.publish(TOPICS.AGENT_SKILL_REQUEST, {
          id: crypto.randomUUID(),
          correlationId,
          parentId: parentMsgId,
          topic: TOPICS.AGENT_SKILL_REQUEST,
          timestamp: Date.now(),
          source: { interface: "cron" },
          reply: { topic: replyTopic },
          payload: {
            skill: action.meta.skillHint ?? action.id,
            content: this._describeDispatch(action),
            goalId: action.goalId,
            meta: { ...action.meta, systemActor: "goap", actionId: action.id, goalId: action.goalId },
          },
        });

        // Subscribe to skill response for this specific correlationId
        const responseSubId = this.bus.subscribe(
          replyTopic,
          this.name + ".await." + correlationId,
          (responseMsg: BusMessage) => {
            const response = responseMsg.payload as AgentSkillResponsePayload;

            // Cancel timeout
            const t = this.pendingTimeouts.get(correlationId);
            if (t) {
              clearTimeout(t);
              this.pendingTimeouts.delete(correlationId);
            }
            this.bus.unsubscribe(responseSubId);

            void this.completeAction(
              action,
              correlationId,
              parentCorrelationId,
              startedAt,
              !response.error,
              response.error
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

    // Publish unified outcome event. ActionDispatcher is the outcome source
    // for tier_0 (short-circuit) actions — for other tiers, SkillDispatcher
    // emits the outcome after the skill completes. Both use the same topic
    // shape so OutcomeAnalysis sees one unified stream.
    const skill = action.meta.skillHint ?? action.id;
    const outcomeTopic = `autonomous.outcome.goap.${skill}`;
    const outcomePayload: AutonomousOutcomePayload = {
      correlationId,
      systemActor: "goap",
      skill,
      actionId: action.id,
      goalId: action.goalId,
      success,
      error,
      taskState: success ? "completed" : (status === "timeout" ? "canceled" : "failed"),
      durationMs: completedAt - startedAt,
    };

    this.bus.publish(outcomeTopic, {
      id: crypto.randomUUID(),
      correlationId: parentCorrelationId,
      topic: outcomeTopic,
      timestamp: completedAt,
      payload: outcomePayload,
    });

    // NOTE: Previously re-published world.state.updated here to close the
    // outcome → state feedback loop. Removed — caused infinite loops in tests
    // because re-publish triggered re-evaluation of a still-violated goal
    // (effects are optimistic, real domain hasn't caught up), which dispatched
    // the same action again. The correct fix lives in the planner: stronger
    // in-flight tracking that waits for domain confirmation, not optimistic
    // effects. Filed as a follow-up.

    // Complete in WIP queue and dispatch next if available
    const next = this.queue.complete(correlationId);
    if (next) {
      await this.executeAction(next.action, next.correlationId, next.parentCorrelationId, crypto.randomUUID(), next.enqueuedAt);
    }
  }

  /**
   * Build a human-readable description of a GOAP dispatch. Carried as
   * `payload.content` so skill-dispatcher has a non-empty "user message"
   * for the episodic memory write under the `system_goap` group.
   * Without this, GOAP dispatches produce no episodes because
   * skill-dispatcher's addEpisode requires both groupId AND originalContent.
   */
  private _describeDispatch(action: import("../planner/types/action.ts").Action): string {
    const goal = action.goalId ? ` to satisfy goal ${action.goalId}` : "";
    const desc = action.description ? ` — ${action.description}` : "";
    return `Autonomous dispatch: ${action.name || action.id}${goal}${desc}`;
  }
}
