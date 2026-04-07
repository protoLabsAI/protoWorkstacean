/**
 * PlannerPluginL0 — deterministic L0 rule-based pattern matcher.
 *
 * Subscribes to: world.state.updated, world.action.outcome
 * Publishes:     world.action.dispatch, world.planner.escalate, world.action.oscillation
 *
 * Flow:
 *   1. On world state update, run registered actions through PatternMatcher
 *   2. Filter out actions on cooldown
 *   3. Check LoopDetector for oscillation; escalate if breached
 *   4. For remaining matching actions, publish world.action.dispatch
 *   5. On outcome feedback, record in LoopDetector for next evaluation
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { WorldState } from "../../lib/types/world-state.ts";
import type {
  ActionDispatchPayload,
  ActionOutcomePayload,
  ActionOscillationPayload,
  PlannerEscalatePayload,
} from "../event-bus/action-events.ts";
import { TOPICS } from "../event-bus/topics.ts";
import { ActionRegistry } from "../planner/action-registry.ts";
import { matchActions } from "../planner/pattern-matcher.ts";
import { LoopDetector } from "../planner/loop-detector.ts";
import { CooldownManager } from "../planner/cooldown-manager.ts";

export interface PlannerPluginL0Config {
  loopDetector?: {
    maxAttempts: number;
    windowMinutes: number;
  };
  /** Cooldown applied after oscillation is detected (ms). Default: 10min. */
  oscillationCooldownMs?: number;
}

const DEFAULT_LOOP_CONFIG = { maxAttempts: 3, windowMinutes: 5 };
const DEFAULT_OSCILLATION_COOLDOWN_MS = 10 * 60 * 1000; // 10 min

export class PlannerPluginL0 implements Plugin {
  readonly name = "planner-l0";
  readonly description = "Deterministic L0 rule-based planner with pattern matching";
  readonly capabilities = ["planning", "pattern-matching", "loop-detection"];

  private bus!: EventBus;
  private readonly subscriptionIds: string[] = [];
  private readonly loopDetector: LoopDetector;
  private readonly cooldownManager: CooldownManager;

  /** Tracks correlationIds currently in-flight to avoid double-dispatch. */
  private readonly inFlightGoals = new Set<string>();

  constructor(
    private readonly registry: ActionRegistry,
    private readonly pluginConfig: PlannerPluginL0Config = {}
  ) {
    const loopCfg = pluginConfig.loopDetector ?? DEFAULT_LOOP_CONFIG;
    this.loopDetector = new LoopDetector(loopCfg);
    this.cooldownManager = new CooldownManager();
  }

  install(bus: EventBus): void {
    this.bus = bus;

    // Evaluate matching actions whenever world state is updated
    const wsId = bus.subscribe(
      TOPICS.WORLD_STATE_UPDATED,
      this.name,
      (msg: BusMessage) => {
        const worldState = msg.payload as WorldState;
        this.evaluate(worldState, msg.correlationId);
      }
    );
    this.subscriptionIds.push(wsId);

    // Track action outcomes for loop detection
    const outcomeId = bus.subscribe(
      TOPICS.WORLD_ACTION_OUTCOME,
      this.name,
      (msg: BusMessage) => {
        const outcome = msg.payload as ActionOutcomePayload;
        this.loopDetector.record(outcome.goalId, outcome.actionId, outcome.success);
        this.inFlightGoals.delete(outcome.goalId);
      }
    );
    this.subscriptionIds.push(outcomeId);
  }

  uninstall(): void {
    for (const id of this.subscriptionIds) {
      this.bus.unsubscribe(id);
    }
    this.subscriptionIds.length = 0;
    this.inFlightGoals.clear();
  }

  /**
   * Evaluate the current world state against all registered actions.
   * Dispatches matching actions that pass cooldown and oscillation checks.
   * May be called directly in tests without going through the bus.
   */
  evaluate(worldState: WorldState, correlationId: string = crypto.randomUUID()): void {
    const allActions = this.registry.getAll();
    const matching = matchActions(allActions, worldState);

    for (const action of matching) {
      // Skip if goal already in-flight
      if (this.inFlightGoals.has(action.goalId)) continue;

      // Skip if on cooldown
      if (this.cooldownManager.isOnCooldown(action.goalId, action.id)) continue;

      // Check for oscillation
      if (this.loopDetector.isOscillating(action.goalId, action.id)) {
        this.handleOscillation(action.goalId, action.id, correlationId);
        continue;
      }

      // Mark goal as in-flight and dispatch
      this.inFlightGoals.add(action.goalId);
      this.dispatchAction(action, worldState, correlationId);
    }
  }

  /** Expose loop detector for introspection. */
  getLoopDetector(): LoopDetector {
    return this.loopDetector;
  }

  /** Expose cooldown manager for introspection. */
  getCooldownManager(): CooldownManager {
    return this.cooldownManager;
  }

  private dispatchAction(
    action: import("../planner/types/action.ts").Action,
    _worldState: WorldState,
    parentCorrelationId: string
  ): void {
    const actionCorrelationId = crypto.randomUUID();

    const dispatchPayload: ActionDispatchPayload = {
      type: "dispatch",
      actionId: action.id,
      goalId: action.goalId,
      action,
      correlationId: actionCorrelationId,
      timestamp: Date.now(),
      optimisticEffectsApplied: action.effects.length > 0,
    };

    this.bus.publish(TOPICS.WORLD_ACTION_DISPATCH, {
      id: crypto.randomUUID(),
      correlationId: actionCorrelationId,
      parentId: parentCorrelationId,
      topic: TOPICS.WORLD_ACTION_DISPATCH,
      timestamp: Date.now(),
      payload: dispatchPayload,
    });
  }

  private handleOscillation(
    goalId: string,
    actionId: string,
    parentCorrelationId: string
  ): void {
    const cooldownMs =
      this.pluginConfig.oscillationCooldownMs ?? DEFAULT_OSCILLATION_COOLDOWN_MS;

    // Apply cooldown to prevent further L0 attempts
    this.cooldownManager.setCooldown(goalId, actionId, cooldownMs);

    // Publish oscillation event
    const history = this.loopDetector.getRecentFailures(goalId, actionId).map((r) => ({
      timestamp: r.timestamp,
      succeeded: r.succeeded,
    }));

    const oscillationPayload: ActionOscillationPayload = {
      type: "oscillation",
      actionId,
      goalId,
      timestamp: Date.now(),
      history,
    };

    this.bus.publish(TOPICS.WORLD_ACTION_OSCILLATION, {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      parentId: parentCorrelationId,
      topic: TOPICS.WORLD_ACTION_OSCILLATION,
      timestamp: Date.now(),
      payload: oscillationPayload,
    });

    // Escalate to tier_1
    const escalatePayload: PlannerEscalatePayload = {
      type: "escalate",
      goalId,
      actionId,
      correlationId: crypto.randomUUID(),
      timestamp: Date.now(),
      reason: `Loop detected: ${this.loopDetector.getRecentFailures(goalId, actionId).length} failures within window`,
      escalateTo: "tier_1",
    };

    this.bus.publish(TOPICS.PLANNER_ESCALATE, {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      parentId: parentCorrelationId,
      topic: TOPICS.PLANNER_ESCALATE,
      timestamp: Date.now(),
      payload: escalatePayload,
    });
  }
}
