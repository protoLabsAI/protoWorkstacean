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
import type { GoalViolatedEventPayload } from "../types/events.ts";
import type { Action } from "../planner/types/action.ts";
import type { EffectRegistration } from "../executor/types.ts";
import { TOPICS } from "../event-bus/topics.ts";
import { ActionRegistry } from "../planner/action-registry.ts";
import { ExecutorRegistry } from "../executor/executor-registry.ts";
import { matchActions, evaluatePrecondition } from "../planner/pattern-matcher.ts";
import { LoopDetector } from "../planner/loop-detector.ts";
import { CooldownManager } from "../planner/cooldown-manager.ts";

export interface PlannerPluginL0Config {
  loopDetector?: {
    maxAttempts: number;
    windowMinutes: number;
  };
  /** Cooldown applied after oscillation is detected (ms). Default: 10min. */
  oscillationCooldownMs?: number;
  /**
   * Cooldown applied after a successful action with effects (ms). Default: 90s.
   * Gives the next real domain poll time to catch up so goals aren't
   * re-evaluated against optimistic effects only. Closes the outcome→state
   * feedback loop without infinite re-dispatch.
   */
  successCooldownMs?: number;
  /**
   * ExecutorRegistry to query when a goal violation carries a desiredEffect.
   * When provided, violations with (domain, path, targetValue) use effect-based
   * candidate selection (resolveByEffect) instead of ActionRegistry.getByGoal().
   */
  executorRegistry?: ExecutorRegistry;
}

const DEFAULT_LOOP_CONFIG = { maxAttempts: 3, windowMinutes: 5 };
const DEFAULT_OSCILLATION_COOLDOWN_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_SUCCESS_COOLDOWN_MS = 90 * 1000; // 90s — longer than 60s domain poll

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

  /** Latest world state snapshot, used for precondition checks on goal violations. */
  private lastWorldState: WorldState | null = null;

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
        this.lastWorldState = worldState;
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

        // Post-success cooldown — prevents re-dispatching the same action
        // against a goal that's still violated because the real domain
        // hasn't polled yet. Without this, the outcome→state feedback loop
        // would fire the same remediation every tick until the real state
        // catches up.
        if (outcome.success) {
          const action = this.registry.get(outcome.actionId);
          if (action && action.effects && action.effects.length > 0) {
            const cooldownMs =
              this.pluginConfig.successCooldownMs ?? DEFAULT_SUCCESS_COOLDOWN_MS;
            this.cooldownManager.setCooldown(outcome.goalId, outcome.actionId, cooldownMs);
          }
        }
      }
    );
    this.subscriptionIds.push(outcomeId);

    // React to goal violations by dispatching matching tier_0 actions
    const violationSubId = bus.subscribe(
      "world.goal.violated",
      this.name,
      async (msg: BusMessage) => {
        const payload = msg.payload as GoalViolatedEventPayload;
        const violation = payload.violation;
        const currentState = this.lastWorldState;
        const executorRegistry = this.pluginConfig.executorRegistry;

        let matchingActions: Action[];

        if (violation.desiredEffect && executorRegistry) {
          // Effect-based selection: query ExecutorRegistry for skills whose
          // declared effect moves world state toward the desired (domain, path).
          // Candidates are sorted by confidence desc (Arc 6 tiebreak: cost).
          const { domain, path } = violation.desiredEffect;
          const candidates = executorRegistry
            .resolveByEffect({ domain, path })
            .sort((a, b) => b.confidence - a.confidence);
          matchingActions = candidates.map((reg) =>
            this.synthesizeActionFromEffect(reg, violation.goalId, domain, path)
          );
        } else {
          // Legacy: goal.id → ActionRegistry lookup
          matchingActions = this.registry.getByGoal(violation.goalId);
        }

        for (const action of matchingActions) {
          if (this.inFlightGoals.has(action.goalId)) continue;
          if (this.cooldownManager.isOnCooldown(action.goalId, action.id)) continue;
          if (this.loopDetector.isOscillating(action.goalId, action.id)) {
            this.handleOscillation(action.goalId, action.id, msg.correlationId);
            continue;
          }
          // Check preconditions against current world state before dispatching
          if (currentState !== null && !action.preconditions.every((p) => evaluatePrecondition(p, currentState))) {
            continue;
          }
          this.inFlightGoals.add(action.goalId);
          this.dispatchAction(action, currentState ?? ({} as WorldState), msg.correlationId);
        }
      }
    );
    this.subscriptionIds.push(violationSubId);
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

  /**
   * Build a synthetic Action from an EffectRegistration.
   * Used when a goal violation specifies a desiredEffect and candidates are
   * resolved via ExecutorRegistry rather than ActionRegistry.
   * Priority is seeded from confidence (0–100) so Arc 6 cost/confidence
   * ranking can be layered on top without changes to the dispatch path.
   */
  private synthesizeActionFromEffect(
    reg: EffectRegistration,
    goalId: string,
    domain: string,
    path: string
  ): Action {
    return {
      id: `effect::${reg.skill}::${domain}::${path}`,
      name: reg.skill,
      description: `Effect-driven: ${reg.skill} moves ${domain}.${path}`,
      goalId,
      tier: "tier_0",
      preconditions: [],
      effects: [],
      cost: 0,
      priority: Math.round(reg.confidence * 100),
      meta: {
        skillHint: reg.skill,
        ...(reg.agentName ? { agentId: reg.agentName } : {}),
      },
    };
  }

  private dispatchAction(
    action: Action,
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
