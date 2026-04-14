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
 */

import type { Plugin, EventBus } from "../../lib/types.ts";
import type { AutonomousOutcomePayload } from "../event-bus/payloads.ts";
import { MODEL_RATES } from "../../lib/types/budget.ts";

const WINDOW_MS = 24 * 60 * 60 * 1_000; // 24 hours
const MAX_RECENT_FAILURES = 10;
const DEFAULT_RATES = MODEL_RATES["default"];

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
  /** Most recent failures (up to 10), most-recent-first. */
  recentFailures: Array<{
    timestamp: number;
    skill: string;
    correlationId: string;
    failureReason?: string;
  }>;
  /** Total outcome events counted in the 24h window. */
  totalOutcomes: number;
}

export interface FleetHealthSnapshot {
  agents: AgentFleetMetrics[];
  /** Always 24 — documents the rolling window. */
  windowHours: 24;
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
  /** Per-agent rolling window. Keys are systemActor values. */
  private readonly agentWindows = new Map<string, OutcomeRecord[]>();

  install(bus: EventBus): void {
    this.bus = bus;
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
    const agents: AgentFleetMetrics[] = [];

    for (const [agentName, records] of this.agentWindows) {
      // Prune stale records
      const fresh = records.filter(r => r.timestamp >= cutoff);
      this.agentWindows.set(agentName, fresh);

      if (fresh.length === 0) continue;

      const successes = fresh.filter(r => r.success);
      const failures = fresh.filter(r => !r.success);
      const successRate = successes.length / fresh.length;

      const durations = fresh.map(r => r.durationMs).sort((a, b) => a - b);
      const p50LatencyMs = _percentile(durations, 0.5);
      const p95LatencyMs = _percentile(durations, 0.95);

      const totalCost = fresh.reduce((sum, r) => sum + r.costUsd, 0);
      const costPerSuccessfulOutcome =
        successes.length > 0 ? totalCost / successes.length : 0;

      const recentFailures = failures
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, MAX_RECENT_FAILURES)
        .map(r => ({
          timestamp: r.timestamp,
          skill: r.skill,
          correlationId: r.correlationId,
          failureReason: r.failureReason,
        }));

      agents.push({
        agentName,
        successRate,
        p50LatencyMs,
        p95LatencyMs,
        costPerSuccessfulOutcome,
        recentFailures,
        totalOutcomes: fresh.length,
      });
    }

    return { agents, windowHours: 24, collectedAt: now };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _record(p: AutonomousOutcomePayload): void {
    const costUsd = p.usage
      ? (p.usage.input_tokens ?? 0) * DEFAULT_RATES.input +
        (p.usage.output_tokens ?? 0) * DEFAULT_RATES.output
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

    const existing = this.agentWindows.get(p.systemActor) ?? [];
    existing.push(record);
    this.agentWindows.set(p.systemActor, existing);
  }
}

// ── Utility ───────────────────────────────────────────────────────────────────

/** Returns the value at the given percentile p (0–1) from a sorted array. */
function _percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}
