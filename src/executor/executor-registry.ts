/**
 * ExecutorRegistry — maps skill names and agent targets to IExecutor instances.
 *
 * Resolution order for a given (skill, targets[]) pair:
 *   1. Named target match — any registration whose agentName is in targets[]
 *   2. Skill-specific registration — sorted by priority desc
 *   3. Default executor — registered via registerDefault()
 *   4. null — no executor found; SkillDispatcherPlugin logs and drops
 */

import type { IExecutor, ExecutorRegistration, HitlMode } from "./types.ts";

export class ExecutorRegistry {
  private readonly _registrations: ExecutorRegistration[] = [];
  private _default: IExecutor | null = null;

  /**
   * Register an executor for a specific skill.
   * If agentName is provided, this registration also matches target-based routing.
   */
  register(
    skill: string,
    executor: IExecutor,
    opts: { agentName?: string; priority?: number; hitlMode?: HitlMode } = {},
  ): void {
    this._registrations.push({
      skill,
      executor,
      agentName: opts.agentName,
      priority: opts.priority ?? 0,
      ...(opts.hitlMode !== undefined ? { hitlMode: opts.hitlMode } : {}),
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
   * Resolve the declared HITL mode for a skill (highest-priority registration wins).
   * Returns undefined if the skill has no registration or no hitlMode declared.
   */
  resolveHitlMode(skill: string): HitlMode | undefined {
    const bySkill = this._registrations
      .filter(r => r.skill === skill && r.hitlMode !== undefined)
      .sort((a, b) => b.priority - a.priority);
    return bySkill[0]?.hitlMode;
  }

  /** All current registrations — useful for diagnostics and health checks. */
  list(): ExecutorRegistration[] {
    return [...this._registrations];
  }

  get size(): number {
    return this._registrations.length;
  }
}
