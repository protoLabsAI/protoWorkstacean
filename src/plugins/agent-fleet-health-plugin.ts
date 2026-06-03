/**
 * AgentFleetHealthPlugin — Arc 8: Fleet-aware homeostasis.
 *
 * Aggregates `autonomous.outcome.#` events over a rolling 24h window into
 * per-agent metrics: successRate, p50/p95 latency, costPerSuccessfulOutcome,
 * and recentFailures.
 *
 * Exposes getFleetHealth() as the collector for the "agent_fleet_health"
 * world state domain — called every 60s by WorldStateEngine.
 *
 * Inbound topics:
 *   autonomous.outcome.#  — every autonomous task terminal state
 *
 * Outcome attribution (issue #459):
 *   Outcome `systemActor` values are whitelisted against the live
 *   ExecutorRegistry before being recorded under the per-agent window.
 *   Unknown actors (plugin names like `feature-remediation`, synthetic labels like
 *   `outcome-analysis`, `goap`, `user`) are routed to a separate
 *   `systemActors[]` bucket in the snapshot so they don't pollute agentCount,
 *   reachableCount, orphanedSkillCount, or maxFailureRate1h. Same chokepoint
 *   discipline as the ActionDispatcher cooldown (#437) and registry guard
 *   (#444): invariants belong at the point an outcome is written.
 */

import type { Plugin, EventBus } from "../../lib/types.ts";
import type { AutonomousOutcomePayload } from "../event-bus/payloads.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import { MODEL_RATES } from "../../lib/types/budget.ts";
import type { FleetStateRepository, OutcomeRecord as PersistedOutcomeRecord } from "../knowledge/fleet-state.ts";

const WINDOW_MS = 24 * 60 * 60 * 1_000; // 24 hours
const WINDOW_1H_MS = 60 * 60 * 1_000; // 1 hour
const MAX_RECENT_FAILURES = 10;
const DEFAULT_RATES = MODEL_RATES["default"];

/**
 * Track which unknown models we've warned about so we don't spam the
 * log on every outcome. One warn per distinct model name across the
 * process lifetime — fits the "fail loud once" convention from #459's
 * synthetic-actor logging.
 */
const _warnedUnknownModels = new Set<string>();

/**
 * Resolve per-token rates for a model. Returns the model-specific entry
 * from MODEL_RATES when set; falls back to DEFAULT_RATES with a one-time
 * warn for unknown models so operators notice when LiteLLM is routing
 * to something we don't have a rate for. Undefined model (no override)
 * silently uses default — that's the documented "we can't tell" case.
 */
function _ratesFor(model: string | undefined): { input: number; output: number } {
  if (!model) return DEFAULT_RATES;
  const rates = MODEL_RATES[model];
  if (rates) return rates;
  if (!_warnedUnknownModels.has(model)) {
    _warnedUnknownModels.add(model);
    console.warn(
      `[agent-fleet-health] No MODEL_RATES entry for "${model}" — using default rate. ` +
        `Add the model to lib/types/budget.ts MODEL_RATES table for accurate cost attribution.`,
    );
  }
  return DEFAULT_RATES;
}

// ── Internal record ───────────────────────────────────────────────────────────

interface OutcomeRecord {
  timestamp: number;
  success: boolean;
  durationMs: number;
  costUsd: number;
  skill: string;
  correlationId: string;
  failureReason?: string;
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface AgentFleetMetrics {
  agentName: string;
  /** Fraction of outcomes that succeeded over the 24h window (0–1). */
  successRate: number;
  /** Median wall-clock duration across all outcomes in the window (ms). */
  p50LatencyMs: number;
  /** 95th-percentile wall-clock duration across all outcomes in the window (ms). */
  p95LatencyMs: number;
  /**
   * Total LLM cost in USD for all outcomes in the window divided by
   * the number of successful outcomes. 0 when successCount is 0 or
   * no usage data is available.
   */
  costPerSuccessfulOutcome: number;
  /** Total raw LLM cost in USD for all outcomes in the 24h window. */
  totalCostUsd: number;
  /** Most recent failures (up to 10), most-recent-first. */
  recentFailures: Array<{
    timestamp: number;
    skill: string;
    correlationId: string;
    failureReason?: string;
  }>;
  /** Total outcome events counted in the 24h window. */
  totalOutcomes: number;
  /**
   * Fraction of outcomes that failed over the last 1h window (0–1).
   * 0 when no outcomes in the 1h window.
   */
  failureRate1h: number;
}

/**
 * Outcome attribution for a systemActor that is NOT a registered A2A or
 * DeepAgent executor. Tracked separately so dashboards and downstream consumers can
 * see that traffic without treating it as agent health signal.
 *
 * Examples: `goap`, `feature-remediation`, `outcome-analysis`,
 * `ceremony.*`. These are plugin / subsystem labels, not agents.
 */
export interface SystemActorOutcomeSummary {
  systemActor: string;
  totalOutcomes: number;
  successCount: number;
  failureCount: number;
}

export interface FleetHealthSnapshot {
  agents: AgentFleetMetrics[];
  /** Always 24 — documents the rolling window. */
  windowHours: 24;
  /**
   * Max failureRate1h across all agents. 0 when no agents have 1h outcomes.
   * Exposed via /api/agent-fleet-health for dashboards and downstream alerting.
   */
  maxFailureRate1h: number;
  /** Sum of all LLM costs across all agents over the 24h window (USD). Used by fleet.cost_under_budget (Arc 8.3). */
  totalCostUsd1d: number;
  /**
   * Count of skills seen in any agent outcome in the 24h window that have had
   * no successful execution during that window. > 0 signals capability
   * regression — a skill is active but consistently failing. Only counts
   * outcomes recorded against REAL agents; synthetic-actor outcomes are
   * excluded so plugin failures don't inflate the orphan count (#459).
   * Used by fleet.no_skill_orphaned (Arc 8.5).
   */
  orphanedSkillCount: number;
  /**
   * Outcomes attributed to systemActor values that are NOT registered
   * executors — plugin / subsystem labels like `feature-remediation`,
   * `outcome-analysis`, `goap`. Kept separate so agentCount and the fleet
   * health metrics reflect the real agent fleet (#459).
   */
  systemActors: SystemActorOutcomeSummary[];
  collectedAt: number;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class AgentFleetHealthPlugin implements Plugin {
  readonly name = "agent-fleet-health";
  readonly description =
    "Aggregates autonomous.outcome.# over a rolling 24h window into per-agent fleet health metrics";
  readonly capabilities = ["fleet-health"];

  private bus?: EventBus;
  private readonly subscriptionIds: string[] = [];
  /** Per-agent rolling window. Keys are systemActor values that match a registered executor. */
  private readonly agentWindows = new Map<string, OutcomeRecord[]>();
  /** Per-systemActor rolling window for names NOT in the ExecutorRegistry. */
  private readonly systemActorWindows = new Map<string, OutcomeRecord[]>();
  /** Synthetic actors seen since last startup — used for the one-time warn. */
  private readonly seenSyntheticActors = new Set<string>();

  constructor(
    /**
     * ExecutorRegistry handle for outcome-attribution whitelist (issue #459).
     * When set, every inbound outcome's `systemActor` is checked against the
     * live registry before being aggregated into `agents[]`. Absent-from-
     * registry actors land in a separate `systemActors[]` bucket. When the
     * registry is not wired (test fixtures that only exercise aggregation
     * math), every actor is treated as an agent — preserving pre-#459 shape
     * for legacy tests until they opt in.
     */
    private readonly executorRegistry?: ExecutorRegistry,
    /**
     * Optional durable backing store (ADR-0004 P5). When set, every outcome is
     * persisted to knowledge.db and the 24h window is rehydrated from it on
     * install(), so fleet health survives restarts. Degrades gracefully — when
     * absent, the in-memory path is unchanged.
     */
    private readonly fleetStateRepo?: FleetStateRepository,
  ) {}

  install(bus: EventBus): void {
    this.bus = bus;

    // Rehydrate the in-memory window from the durable store on startup.
    if (this.fleetStateRepo) {
      const records = this.fleetStateRepo.hydrateRecords(24);
      for (const r of records) this._addToWindow(r);
      if (records.length > 0) {
        console.log(`[agent-fleet-health] hydrated ${records.length} records from knowledge.db`);
      }
    }

    this.subscriptionIds.push(
      bus.subscribe("autonomous.outcome.#", this.name, (msg) => {
        const p = msg.payload as AutonomousOutcomePayload | undefined;
        if (!p?.systemActor) return;
        this._record(p);
      }),
    );
    console.log("[agent-fleet-health] Installed — aggregating autonomous.outcome.#");
  }

  uninstall(): void {
    if (this.bus) {
      for (const id of this.subscriptionIds) this.bus.unsubscribe(id);
    }
    this.subscriptionIds.length = 0;
    this.bus = undefined;
  }

  /**
   * Collector for WorldStateEngine — call every 60s to publish a domain snapshot.
   * Prunes stale (>24h) records in-place on each call.
   */
  getFleetHealth(): FleetHealthSnapshot {
    const now = Date.now();
    const cutoff = now - WINDOW_MS;
    const cutoff1h = now - WINDOW_1H_MS;
    const agents: AgentFleetMetrics[] = [];

    // Per-skill: track whether any success exists in the window.
    // Only real agents contribute — synthetic-actor failures shouldn't
    // flag a skill as orphaned (#459).
    const skillSeenInWindow = new Set<string>();
    const skillHasSuccessInWindow = new Set<string>();

    for (const [agentName, records] of this.agentWindows) {
      // Prune stale records
      const fresh = records.filter(r => r.timestamp >= cutoff);
      this.agentWindows.set(agentName, fresh);

      if (fresh.length === 0) continue;

      for (const r of fresh) {
        skillSeenInWindow.add(r.skill);
        if (r.success) skillHasSuccessInWindow.add(r.skill);
      }

      const successes = fresh.filter(r => r.success);
      const failures = fresh.filter(r => !r.success);
      const successRate = successes.length / fresh.length;

      const durations = fresh.map(r => r.durationMs).sort((a, b) => a - b);
      const p50LatencyMs = _percentile(durations, 0.5);
      const p95LatencyMs = _percentile(durations, 0.95);

      const totalCostUsd = fresh.reduce((sum, r) => sum + r.costUsd, 0);
      const costPerSuccessfulOutcome =
        successes.length > 0 ? totalCostUsd / successes.length : 0;

      const recentFailures = failures
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, MAX_RECENT_FAILURES)
        .map(r => ({
          timestamp: r.timestamp,
          skill: r.skill,
          correlationId: r.correlationId,
          failureReason: r.failureReason,
        }));

      const fresh1h = fresh.filter(r => r.timestamp >= cutoff1h);
      const failures1h = fresh1h.filter(r => !r.success);
      const failureRate1h = fresh1h.length > 0 ? failures1h.length / fresh1h.length : 0;

      agents.push({
        agentName,
        successRate,
        p50LatencyMs,
        p95LatencyMs,
        costPerSuccessfulOutcome,
        totalCostUsd,
        recentFailures,
        totalOutcomes: fresh.length,
        failureRate1h,
      });
    }

    const maxFailureRate1h = agents.length > 0
      ? Math.max(...agents.map(a => a.failureRate1h))
      : 0;
    const totalCostUsd1d = agents.reduce((sum, a) => sum + a.totalCostUsd, 0);

    let orphanedSkillCount = 0;
    for (const skill of skillSeenInWindow) {
      if (!skillHasSuccessInWindow.has(skill)) orphanedSkillCount++;
    }

    // Prune + summarize synthetic-actor buckets.
    const systemActors: SystemActorOutcomeSummary[] = [];
    for (const [actor, records] of this.systemActorWindows) {
      const fresh = records.filter(r => r.timestamp >= cutoff);
      this.systemActorWindows.set(actor, fresh);
      if (fresh.length === 0) continue;
      const successCount = fresh.filter(r => r.success).length;
      systemActors.push({
        systemActor: actor,
        totalOutcomes: fresh.length,
        successCount,
        failureCount: fresh.length - successCount,
      });
    }

    return {
      agents,
      windowHours: 24,
      maxFailureRate1h,
      totalCostUsd1d,
      orphanedSkillCount,
      systemActors,
      collectedAt: now,
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _record(p: AutonomousOutcomePayload): void {
    const rates = _ratesFor(p.model);
    const costUsd = p.usage
      ? (p.usage.input_tokens ?? 0) * rates.input +
        (p.usage.output_tokens ?? 0) * rates.output
      : 0;

    const record: OutcomeRecord = {
      timestamp: Date.now(),
      success: p.success,
      durationMs: p.durationMs,
      costUsd,
      skill: p.skill,
      correlationId: p.correlationId,
      failureReason: p.success ? undefined : (p.taskState ?? "failed"),
    };

    if (this._isRegisteredAgent(p.systemActor)) {
      const existing = this.agentWindows.get(p.systemActor) ?? [];
      existing.push(record);
      this.agentWindows.set(p.systemActor, existing);
    } else {
      // Synthetic actor: plugin / subsystem label that isn't a real executor.
      // Log once per distinct actor so operators can see what's being filtered
      // without flooding on every outcome.
      if (!this.seenSyntheticActors.has(p.systemActor)) {
        this.seenSyntheticActors.add(p.systemActor);
        console.warn(
          `[agent-fleet-health] synthetic_actor_filtered systemActor=${p.systemActor} ` +
            `skill=${p.skill} — not in ExecutorRegistry; aggregating under systemActors[] ` +
            `instead of agents[]. Fix source so it doesn't masquerade as an agent.`,
        );
      }
      const existing = this.systemActorWindows.get(p.systemActor) ?? [];
      existing.push(record);
      this.systemActorWindows.set(p.systemActor, existing);
    }

    // Persist to the durable store (fire-and-forget; degrades to no-op when absent).
    this.fleetStateRepo?.recordOutcome({
      systemActor: p.systemActor,
      skill: p.skill,
      success: p.success,
      durationMs: p.durationMs,
      costUsd,
      correlationId: p.correlationId,
      failureReason: record.failureReason,
      model: p.model,
      inputTokens: p.usage?.input_tokens,
      outputTokens: p.usage?.output_tokens,
      timestamp: record.timestamp,
    });
  }

  /**
   * Add a hydrated record (from FleetStateRepository on startup) to the correct
   * in-memory window. Mirrors `_record`'s routing without re-persisting or
   * re-warning, since these rows came from the store.
   */
  private _addToWindow(r: PersistedOutcomeRecord): void {
    const record: OutcomeRecord = {
      timestamp: r.timestamp,
      success: r.success,
      durationMs: r.durationMs,
      costUsd: r.costUsd,
      skill: r.skill,
      correlationId: r.correlationId,
      failureReason: r.failureReason,
    };
    const window = this._isRegisteredAgent(r.systemActor) ? this.agentWindows : this.systemActorWindows;
    const existing = window.get(r.systemActor) ?? [];
    existing.push(record);
    window.set(r.systemActor, existing);
  }

  /**
   * Returns true when `actor` is a registered executor agentName.
   *
   * No registry wired → every actor is treated as an agent (preserves
   * pre-#459 aggregation shape for legacy tests that don't need the guard).
   * Empty registry → nothing is an agent; all outcomes go to systemActors[].
   */
  private _isRegisteredAgent(actor: string): boolean {
    if (!this.executorRegistry) return true;
    const known = this.executorRegistry
      .list()
      .map(r => r.agentName)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
    return known.includes(actor);
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

/** Returns the value at the given percentile p (0–1) from a sorted array. */
function _percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}
