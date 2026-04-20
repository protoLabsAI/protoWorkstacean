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
import type { TelemetryService } from "../telemetry/telemetry-service.ts";
import { GOAL_EVENTS } from "../telemetry/telemetry-service.ts";
import { TOPICS } from "../event-bus/topics.ts";
import { resolvePath } from "../engines/state_diff_engine.ts";

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

  // Selector validator runs once after the first valid world-state evaluation;
  // reset whenever goals are reloaded so re-loaded selector drift is caught too.
  private validatorRan = false;

  constructor(config?: Partial<GoalsConfig>, private readonly telemetry?: TelemetryService) {
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

    // Hot-reload triggers — two flavors live side by side:
    //   goals.reload   — narrow signal from GoalHotReloadPlugin (Arc 9.2)
    //                    after a HITL-approved goal proposal is written to
    //                    goals.yaml. Single-file, single-purpose.
    //   config.reload  — broad signal from the workspace config gate (Arc 9.4)
    //                    after a ConfigChangeHITL approval lands. Covers
    //                    goals.yaml + actions.yaml + agent cards.
    // Both just re-read goals from disk; subscribing to both keeps each
    // writer's contract intact without requiring them to coordinate.
    const goalsReloadId = bus.subscribe("goals.reload", this.name, () => {
      console.log("[goal-evaluator] goals.reload received — reloading goals from disk");
      this.reloadGoals();
    });
    this.subscriptionIds.push(goalsReloadId);

    const configReloadId = bus.subscribe(TOPICS.CONFIG_RELOAD, this.name, () => {
      console.info("[goal-evaluator] config.reload received — reloading goals from disk");
      this.reloadGoals();
    });
    this.subscriptionIds.push(configReloadId);

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

        // Telemetry: one eval bumps `evaluated`, then either satisfied or violated
        this.telemetry?.bump("goal", goal.id, "evaluated");
        this.telemetry?.bump("goal", goal.id, violation ? "violated" : "satisfied");

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
    // Re-arm the selector validator so freshly loaded goals get checked
    // against the next incoming world state.
    this.validatorRan = false;
    console.info(
      `[goal-evaluator] Loaded ${this.goals.length} goal(s) from ${loaded.source}${projectSlug ? ` (project: ${projectSlug})` : ""}`,
    );
    // Register every loaded goal with zero counts so the audit view surfaces
    // "loaded but never evaluated" as well as "evaluated but never violated".
    if (this.telemetry) {
      for (const goal of this.goals) {
        this.telemetry.registerKnown("goal", goal.id, GOAL_EVENTS);
      }
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Defensive shape check — does this look like a WorldState snapshot?
   *
   * The bus delivers everything published on `world.state.#` to this plugin.
   * Some publishers in the past have leaked non-WorldState payloads onto that
   * namespace (e.g. CeremonyStateExtension publishing a `{ domain, data }`
   * envelope on `world.state.snapshot`, see issue #424). Without this guard,
   * every loaded goal fires a Selector-not-found violation per leaked event,
   * spamming Discord and exhausting fail-fast credibility.
   *
   * A real WorldState always has either `domains` or `extensions` at the top
   * level (see lib/types/world-state.ts WorldState shape). For the test/back-
   * compat path where callers publish a flat object as the state, we accept
   * any plain object with at least one own key — that's enough to evaluate
   * top-level selectors like "status" used in unit tests.
   */
  private _looksLikeWorldState(state: unknown): state is WorldState {
    if (state === null || typeof state !== "object" || Array.isArray(state)) return false;
    const obj = state as Record<string, unknown>;
    // Reject single-domain envelope shape: { domain: "x", data: {...} }.
    // That's a per-domain snapshot, not a WorldState. (issue #424 — caused by
    // CeremonyStateExtension publishing on world.state.snapshot with this shape.)
    if (typeof obj.domain === "string" && "data" in obj && !("domains" in obj)) return false;
    // Production WorldState shape (built by WorldStateEngine)
    if ("domains" in obj || "extensions" in obj) return true;
    // Test/dev shape — flat objects with arbitrary top-level selector keys
    // (e.g. { status: "ok" }, { metrics: { cpu: 92 } }) used by unit tests
    // and simple downstream publishers.
    return Object.keys(obj).length > 0;
  }

  private async _handleWorldState(msg: BusMessage): Promise<void> {
    const payload = msg.payload as Record<string, unknown>;
    const state = (payload.state ?? payload) as unknown;
    const projectSlug = typeof payload.projectSlug === "string" ? payload.projectSlug : undefined;

    if (!this._looksLikeWorldState(state)) {
      // Loud once-per-topic warning; do not evaluate — this prevents a single
      // misrouted publisher from generating one violation per loaded goal.
      console.warn(
        `[goal-evaluator] Ignoring non-WorldState payload on "${msg.topic}" — ` +
        `expected { domains, extensions, ... }, got ${this._describePayload(state)}`,
      );
      return;
    }

    let violations: GoalViolation[];
    try {
      violations = this.evaluateState(state, projectSlug);
    } catch (err) {
      console.error("[goal-evaluator] World state query failed — skipping evaluation cycle:", err);
      return;
    }

    // First valid eval — run the selector validator once. Catches loud, early,
    // any goal whose selector path doesn't resolve against the real world state.
    if (!this.validatorRan) {
      this.validatorRan = true;
      this._validateLoadedGoalSelectors(state);
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

  private _describePayload(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value !== "object") return typeof value;
    const keys = Object.keys(value as Record<string, unknown>);
    return `object with keys [${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", ..." : ""}]`;
  }

  /**
   * Walk every loaded goal's selector against the live world state on first
   * eval. Any selector that doesn't resolve gets a HIGH-severity warning so
   * goal/producer drift is surfaced loud at startup instead of silently
   * generating a violation per evaluation cycle.
   *
   * This is the goal-side analogue of the skill-executor validator (issue #426).
   */
  private _validateLoadedGoalSelectors(state: WorldState): void {
    const unresolved: Array<{ id: string; selector: string }> = [];
    for (const goal of this.goals) {
      if (!goal.selector) continue;
      const { found } = resolvePath(state, goal.selector);
      if (!found) unresolved.push({ id: goal.id, selector: goal.selector });
    }

    if (unresolved.length === 0) {
      console.info(
        `[goal-evaluator:validator] All ${this.goals.length} loaded goal selector(s) resolve against the current world state.`,
      );
      return;
    }

    console.error(
      `[goal-evaluator:validator] [HIGH] ${unresolved.length} goal(s) reference selector paths not present in world state ` +
      `(producers were renamed, removed, or never registered):`,
    );
    for (const u of unresolved) {
      console.error(`  - goal="${u.id}" selector="${u.selector}"`);
    }
    console.error(
      `[goal-evaluator:validator] Fix by either updating the goal selector in workspace/goals.yaml ` +
      `or restoring the producer that publishes the missing field.`,
    );
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
