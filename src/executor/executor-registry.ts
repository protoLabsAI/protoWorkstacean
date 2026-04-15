/**
 * ExecutorRegistry — maps skill names and agent targets to IExecutor instances.
 *
 * Resolution order for a given (skill, targets[]) pair:
 *   1. Named target match — any registration whose agentName is in targets[]
 *   2. Skill-specific registration — health-score weighted when a getter is set,
 *      otherwise highest priority wins
 *   3. Default executor — registered via registerDefault()
 *   4. null — no executor found; SkillDispatcherPlugin logs and drops
 *
 * Health-weighted selection (Arc 8):
 *   When multiple agents can serve the same skill and a healthGetter is set,
 *   candidates are selected by weighted random draw using:
 *     weight = successRate × (1 / (1 + costPerSuccessfulOutcome))
 *   Agents with no data receive a neutral weight of 1.0 so they still receive
 *   traffic and can build up a reputation.
 */

import type { IExecutor, ExecutorRegistration } from "./types.ts";

// Minimal health metrics interface — compatible with AgentFleetMetrics
// but avoids a direct import from the plugins layer.
interface AgentHealthMetrics {
  agentName: string;
  successRate: number;
  costPerSuccessfulOutcome: number;
  totalOutcomes: number;
}

type HealthGetter = () => AgentHealthMetrics[];

export class ExecutorRegistry {
  private readonly _registrations: ExecutorRegistration[] = [];
  private _default: IExecutor | null = null;
  private _healthGetter: HealthGetter | null = null;

  /**
   * Inject a live fleet-health snapshot provider.
   * Called once at startup by the bootstrap code after AgentFleetHealthPlugin
   * is registered. If never called, resolve() falls back to priority ordering.
   */
  setHealthGetter(fn: HealthGetter): void {
    this._healthGetter = fn;
  }

  /**
   * Register an executor for a specific skill.
   * If agentName is provided, this registration also matches target-based routing.
   */
  register(
    skill: string,
    executor: IExecutor,
    opts: { agentName?: string; priority?: number } = {},
  ): void {
    this._registrations.push({
      skill,
      executor,
      agentName: opts.agentName,
      priority: opts.priority ?? 0,
    });
  }

  /**
   * Register a fallback executor used when no skill-specific match is found.
   * Only one default is supported; subsequent calls replace the previous.
   */
  registerDefault(executor: IExecutor): void {
    this._default = executor;
  }

  /**
   * Resolve the executor for a (skill, targets) pair.
   * Returns null if nothing matches and no default is set.
   */
  resolve(skill: string, targets: string[] = []): IExecutor | null {
    // 1. Named target match — search ALL registrations by agentName.
    //    Explicit targets override skill-based routing entirely.
    if (targets.length > 0) {
      for (const target of targets) {
        const byTarget = this._registrations.find(r => r.agentName === target);
        if (byTarget) return byTarget.executor;
      }
    }

    // 2. Skill-specific match with optional health-weighted selection
    const bySkill = this._registrations.filter(r => r.skill === skill);
    if (bySkill.length > 0) return this._resolveByHealth(bySkill);

    // 3. Default
    return this._default;
  }

  /** All current registrations — useful for diagnostics and health checks. */
  list(): ExecutorRegistration[] {
    return [...this._registrations];
  }

  get size(): number {
    return this._registrations.length;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /**
   * Select an executor from a set of skill-matching registrations.
   *
   * When a healthGetter is set and there are multiple distinct agents,
   * uses weighted random selection (Arc 8 fleet-aware homeostasis).
   * Otherwise falls back to highest-priority-wins.
   */
  private _resolveByHealth(registrations: ExecutorRegistration[]): IExecutor {
    // Group registrations by agentName — keep highest priority per agent.
    // Anonymous registrations (no agentName) share a single slot.
    const byAgent = new Map<string, ExecutorRegistration>();
    for (const reg of registrations) {
      const key = reg.agentName ?? "__anonymous__";
      const existing = byAgent.get(key);
      if (!existing || reg.priority > existing.priority) {
        byAgent.set(key, reg);
      }
    }

    if (byAgent.size === 1 || !this._healthGetter) {
      // Single candidate or no health data — priority ordering suffices.
      return [...byAgent.values()].sort((a, b) => b.priority - a.priority)[0]
        .executor;
    }

    // Multiple distinct agents — weighted random selection by health score.
    const healthData = this._healthGetter();
    const candidates = [...byAgent.values()];
    const weights = candidates.map(reg => _healthWeight(reg.agentName, healthData));

    return _weightedRandom(candidates, weights).executor;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Compute a selection weight for a candidate agent.
 *   weight = successRate × (1 / (1 + costPerSuccessfulOutcome))
 *
 * Agents with no recorded outcomes (or no agentName) receive 1.0 so they
 * still receive traffic and can accumulate health data.
 */
function _healthWeight(
  agentName: string | undefined,
  healthData: AgentHealthMetrics[],
): number {
  if (!agentName) return 1.0;
  const metrics = healthData.find(m => m.agentName === agentName);
  if (!metrics || metrics.totalOutcomes === 0) return 1.0;
  const costEfficiency = 1 / (1 + metrics.costPerSuccessfulOutcome);
  return metrics.successRate * costEfficiency;
}

/**
 * Select one item by weighted random draw.
 * Items with weight 0 are never chosen unless all weights are 0,
 * in which case the first item is returned.
 */
function _weightedRandom<T>(items: T[], weights: number[]): T {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total === 0) return items[0];
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}
