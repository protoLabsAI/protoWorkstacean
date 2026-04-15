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

import type { IExecutor, ExecutorRegistration, EffectRegistration } from "./types.ts";

// Minimal health metrics interface — compatible with AgentFleetMetrics
// but avoids a direct import from the plugins layer.
interface AgentHealthMetrics {
  agentName: string;
  successRate: number;
  costPerSuccessfulOutcome: number;
  totalOutcomes: number;
}

type HealthGetter = () => AgentHealthMetrics[];

/**
 * Optional hook called after standard resolution.
 * Receives (skill, targets, resolved) where resolved is the standard result.
 * Return a different executor to override, or resolved to keep the default.
 * Used by SkillAbTestPlugin to intercept specific skills under A/B test.
 */
export type ResolveHook = (
  skill: string,
  targets: string[],
  resolved: IExecutor | null,
) => IExecutor | null;

export class ExecutorRegistry {
  private readonly _registrations: ExecutorRegistration[] = [];
  private _default: IExecutor | null = null;
  /** Secondary index: `${domain}::${path}` → EffectRegistration[] */
  private readonly _effectIndex = new Map<string, EffectRegistration[]>();
  private _healthGetter: HealthGetter | null = null;
  private _resolveHook: ResolveHook | null = null;

  /**
   * Inject a live fleet-health snapshot provider (Arc 8.4).
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

    // 2. Skill-specific match — health-weighted ordering when a health
    //    getter is registered (Arc 8.4), priority sort otherwise.
    const bySkill = this._registrations.filter(r => r.skill === skill);
    const resolved = bySkill.length > 0
      ? this._resolveByHealth(bySkill)
      : this._default;

    // 3. Optional hook — allows SkillAbTestPlugin to intercept (Arc 9.5)
    if (this._resolveHook) return this._resolveHook(skill, targets, resolved);

    return resolved;
  }

  /**
   * Set (or clear) a resolve hook.
   * The hook runs after standard resolution and may return a different executor.
   * Pass null to remove the hook.
   * Used by SkillAbTestPlugin to intercept skills under A/B test.
   */
  setResolveHook(hook: ResolveHook | null): void {
    this._resolveHook = hook;
  }

  /**
   * Register a skill's declared world-state effects for effect-based planning.
   * Multiple calls for the same (domain, path) accumulate — all candidates are
   * returned by resolveByEffect so the planner can rank them.
   *
   * @param skill     - Skill name that produces these effects.
   * @param agentName - Optional agent name for target-based routing.
   * @param effects   - One or more effect entries: { domain, path, expectedDelta, confidence }.
   */
  registerEffect(
    skill: string,
    agentName: string | undefined,
    effects: Array<{ domain: string; path: string; expectedDelta: number; confidence: number }>,
  ): void {
    for (const e of effects) {
      const key = `${e.domain}::${e.path}`;
      const entry: EffectRegistration = {
        skill,
        agentName,
        domain: e.domain,
        path: e.path,
        expectedDelta: e.expectedDelta,
        confidence: e.confidence,
      };
      const bucket = this._effectIndex.get(key);
      if (bucket) {
        bucket.push(entry);
      } else {
        this._effectIndex.set(key, [entry]);
      }
    }
  }

  /**
   * Resolve all skills that declare an effect on a specific (domain, path) target.
   * Returns candidates in registration order. Returns an empty array when nothing
   * matches — callers should fall back to skill-name routing if needed.
   */
  resolveByEffect(target: { domain: string; path: string }): EffectRegistration[] {
    const key = `${target.domain}::${target.path}`;
    return [...(this._effectIndex.get(key) ?? [])];
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
