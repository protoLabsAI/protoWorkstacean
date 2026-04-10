import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { Goal, GoalViolation } from "../types/goals.ts";
import type { WorldState } from "../types/state_diff.ts";
import type { IGoalEvaluatorPlugin } from "./goal_evaluator_plugin.interface.ts";
import type { GoalsConfig } from "../config/goals_config.ts";
import { DEFAULT_GOALS_CONFIG } from "../config/goals_config.ts";
import { GoalsLoader } from "../loaders/goals_loader.ts";
import { InvariantGoalEvaluator } from "../evaluators/invariant_goal_evaluator.ts";
import { ThresholdGoalEvaluator } from "../evaluators/threshold_goal_evaluator.ts";
import { DistributionGoalEvaluator } from "../evaluators/distribution_goal_evaluator.ts";
import { LangfuseLogger } from "../integrations/langfuse_logger.ts";
import { DiscordLogger } from "../integrations/discord_logger.ts";
import type { GoalViolatedEventPayload } from "../types/events.ts";

/**
 * GoalEvaluatorPlugin — observe-only goal registry + evaluator.
 *
 * Subscribes to world.state.# topics and evaluates loaded goals against
 * incoming world state. Emits world.goal.violated events on violations
 * and logs to Langfuse + Discord.
 *
 * IMPORTANT: Operates in observe-only mode — never triggers planner actions.
 */
export class GoalEvaluatorPlugin implements Plugin, IGoalEvaluatorPlugin {
  readonly name = "goal-evaluator";
  readonly description = "Observe-only goal registry evaluator — diffs world state against goals and emits violations";
  readonly capabilities = ["goals", "evaluation", "observe-only"];

  private readonly observeOnly: boolean;

  private config: GoalsConfig;
  private loader: GoalsLoader;
  private goals: Goal[] = [];

  private invariantEvaluator = new InvariantGoalEvaluator();
  private thresholdEvaluator = new ThresholdGoalEvaluator();
  private distributionEvaluator = new DistributionGoalEvaluator();

  private langfuse: LangfuseLogger;
  private discord: DiscordLogger;

  private bus: EventBus | null = null;
  private subscriptionIds: string[] = [];

  // EventBus unavailability buffer
  private violationBuffer: GoalViolation[] = [];

  constructor(config?: Partial<GoalsConfig>) {
    this.config = { ...DEFAULT_GOALS_CONFIG, ...config };
    this.observeOnly = this.config.observeOnly;
    this.loader = new GoalsLoader(this.config.workspaceDir, this.config.projectsBaseDir);
    this.langfuse = new LangfuseLogger();
    this.discord = new DiscordLogger();
  }

  install(bus: EventBus): void {
    this.bus = bus;

    // Load global goals on startup
    this.reloadGoals();

    // Subscribe to world state update events
    const subId = bus.subscribe("world.state.#", this.name, async (msg: BusMessage) => {
      await this._handleWorldState(msg);
    });
    this.subscriptionIds.push(subId);

    // Flush any buffered violations now that bus is available
    if (this.violationBuffer.length > 0) {
      console.info(`[goal-evaluator] Flushing ${this.violationBuffer.length} buffered violation(s)`);
      const buffered = [...this.violationBuffer];
      this.violationBuffer = [];
      for (const v of buffered) {
        this._emitViolation(v);
      }
    }

    console.log(`[goal-evaluator] Plugin installed — listening on world.state.# (${this.observeOnly ? "observe-only" : "active"} mode)`);
  }

  uninstall(): void {
    if (this.bus) {
      for (const id of this.subscriptionIds) {
        this.bus.unsubscribe(id);
      }
    }
    this.subscriptionIds = [];
    this.bus = null;
  }

  /** Evaluate all loaded goals against the provided world state. */
  evaluateState(state: WorldState, projectSlug?: string): GoalViolation[] {
    const violations: GoalViolation[] = [];

    for (const goal of this.goals) {
      try {
        let violation: GoalViolation | null = null;

        if (goal.type === "Invariant") {
          violation = this.invariantEvaluator.evaluate(goal, state, projectSlug);
        } else if (goal.type === "Threshold") {
          violation = this.thresholdEvaluator.evaluate(goal, state, projectSlug);
        } else if (goal.type === "Distribution") {
          violation = this.distributionEvaluator.evaluate(goal, state, projectSlug);
        }

        if (violation) {
          violations.push(violation);
        }
      } catch (err) {
        console.error(`[goal-evaluator] Evaluation error for goal "${goal.id}" — skipping:`, err);
      }
    }

    return violations;
  }

  /** Reload goals from disk. Optionally scoped to a project slug. */
  reloadGoals(projectSlug?: string): void {
    const loaded = this.loader.loadMerged(projectSlug);
    this.goals = loaded.goals;
    console.info(
      `[goal-evaluator] Loaded ${this.goals.length} goal(s) from ${loaded.source}${projectSlug ? ` (project: ${projectSlug})` : ""}`,
    );
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _handleWorldState(msg: BusMessage): Promise<void> {
    const payload = msg.payload as Record<string, unknown>;
    const state = (payload.state ?? payload) as WorldState;
    const projectSlug = typeof payload.projectSlug === "string" ? payload.projectSlug : undefined;

    let violations: GoalViolation[];
    try {
      violations = this.evaluateState(state, projectSlug);
    } catch (err) {
      console.error("[goal-evaluator] World state query failed — skipping evaluation cycle:", err);
      return;
    }

    for (const violation of violations) {
      this._emitViolation(violation);
      // Log to integrations asynchronously; failures do not block main flow
      this.langfuse.logViolation(violation).catch(err => {
        console.error("[goal-evaluator] Langfuse logging error:", err);
      });
      this.discord.logViolation(violation).catch(err => {
        console.error("[goal-evaluator] Discord logging error:", err);
      });
    }
  }

  private _emitViolation(violation: GoalViolation): void {
    if (!this.bus) {
      console.warn("[goal-evaluator] EventBus unavailable — buffering violation:", violation.goalId);
      this.violationBuffer.push(violation);
      return;
    }

    // Safety guard: in observe-only mode, log but do not emit to bus
    if (this.observeOnly) {
      console.info(`[goal-evaluator] OBSERVE-ONLY VIOLATION [${violation.severity.toUpperCase()}] goal="${violation.goalId}" — ${violation.message}`);
      return;
    }

    const topic = "world.goal.violated";
    const eventPayload: GoalViolatedEventPayload = {
      type: "world.goal.violated",
      violation,
    };

    this.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic,
      timestamp: Date.now(),
      payload: eventPayload,
    });

    console.warn(
      `[goal-evaluator] VIOLATION [${violation.severity.toUpperCase()}] goal="${violation.goalId}" — ${violation.message}`,
    );
  }
}
