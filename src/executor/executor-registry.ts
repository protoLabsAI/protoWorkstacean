/**
 * ExecutorRegistry — maps skill names and agent targets to IExecutor instances.
 *
 * Resolution order for a given (skill, targets[]) pair:
 *   1. Named target match — any registration whose agentName is in targets[]
 *   2. Skill-specific registration — sorted by priority desc
 *   3. Default executor — registered via registerDefault()
 *   4. null — no executor found; SkillDispatcherPlugin logs and drops
 */

import type { IExecutor, ExecutorRegistration, EffectRegistration } from "./types.ts";

export class ExecutorRegistry {
  private readonly _registrations: ExecutorRegistration[] = [];
  private _default: IExecutor | null = null;
  /** Secondary index: `${domain}::${path}` → EffectRegistration[] */
  private readonly _effectIndex = new Map<string, EffectRegistration[]>();

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

    // 2. Skill-specific match (highest priority first)
    const bySkill = this._registrations
      .filter(r => r.skill === skill)
      .sort((a, b) => b.priority - a.priority);
    if (bySkill.length > 0) return bySkill[0].executor;

    // 3. Default
    return this._default;
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
}
