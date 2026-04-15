/**
 * ExecutorRegistry — maps skill names and agent targets to IExecutor instances.
 *
 * Resolution order for a given (skill, targets[]) pair:
 *   1. Named target match — any registration whose agentName is in targets[]
 *   2. Skill-specific registration — sorted by priority desc
 *   3. Default executor — registered via registerDefault()
 *   4. null — no executor found; SkillDispatcherPlugin logs and drops
 */

import type { IExecutor, ExecutorRegistration } from "./types.ts";

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
  private _resolveHook: ResolveHook | null = null;

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
    const resolved = bySkill.length > 0 ? bySkill[0].executor : this._default;

    // 3. Optional hook — allows SkillAbTestPlugin to intercept
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

  /** All current registrations — useful for diagnostics and health checks. */
  list(): ExecutorRegistration[] {
    return [...this._registrations];
  }

  get size(): number {
    return this._registrations.length;
  }
}
