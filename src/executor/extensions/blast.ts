/**
 * Blast v1 extension — declares the scope of effect for a skill so the
 * planner can apply stricter HITL gates to higher-blast-radius work
 * regardless of goal-level config (Arc 6.4 + 7.x coordination).
 *
 * Agents advertise a per-skill BlastRadius in their agent card. This
 * extension does NOT mutate outbound traffic — it's purely a read-side
 * declaration that downstream consumers (planner, HITL policy, dashboards)
 * use to weight, gate, or report skills.
 *
 *   before(ctx): stamps `x-blast-radius` on outbound metadata with the
 *     agent-declared blast radius for the skill, so consumers in the
 *     execution chain can see it without a second lookup.
 *
 *   after(ctx, result): no-op — blast is a policy declaration, not an
 *     observation. A separate consumer can subscribe to `autonomous.outcome.#`
 *     and cross-reference the blast radius stored here.
 *
 * Extension URI: https://protolabs.ai/a2a/ext/blast-v1
 */

import {
  defaultExtensionRegistry,
  type ExtensionInterceptor,
  type ExtensionContext,
} from "../extension-registry.ts";

export const BLAST_URI = "https://protolabs.ai/a2a/ext/blast-v1";

/**
 * Scope of effect for a skill. Ordered from narrowest to widest.
 *
 * - `self`    — only affects the agent's own internal state (e.g. a sitrep)
 * - `project` — affects one project's state (e.g. updates a board feature)
 * - `repo`    — affects a single git repository (e.g. opens a PR)
 * - `fleet`   — affects multiple repos or agents (e.g. bulk migration)
 * - `public`  — externally visible state (e.g. production deploy, public post)
 */
export type BlastRadius = "self" | "project" | "repo" | "fleet" | "public";

/** Ordinal ranking used when comparing two radii numerically. */
export const BLAST_ORDER: Record<BlastRadius, number> = {
  self: 0,
  project: 1,
  repo: 2,
  fleet: 3,
  public: 4,
};

/**
 * Per-(agent, skill) blast declaration from the agent card. Stored in the
 * registry below so non-execution-path consumers (planner, HITL policy,
 * dashboard) can look it up without going through the extension interceptor.
 */
export interface BlastDeclaration {
  agentName: string;
  skill: string;
  radius: BlastRadius;
  /** Optional human-readable explanation for the declared radius. */
  note?: string;
}

/**
 * Registry of declared blast radii. Populated at agent-card ingestion time
 * (SkillBrokerPlugin + agent-card discovery) and queried by the planner.
 *
 * In-memory by design — re-populated on agent-card refresh.
 */
export class BlastRegistry {
  private readonly byKey = new Map<string, BlastDeclaration>();

  static key(agentName: string, skill: string): string {
    return `${agentName}::${skill}`;
  }

  declare(decl: BlastDeclaration): void {
    this.byKey.set(BlastRegistry.key(decl.agentName, decl.skill), decl);
  }

  get(agentName: string, skill: string): BlastDeclaration | undefined {
    return this.byKey.get(BlastRegistry.key(agentName, skill));
  }

  /**
   * Compare two declared radii. Returns a negative number if `a < b`, 0 if
   * equal, positive if `a > b`. Unset defaults to `self` (conservative — an
   * unmarked skill is assumed low-blast, not high-blast; the planner caller
   * decides the safety bias).
   */
  compare(a: BlastRadius | undefined, b: BlastRadius | undefined): number {
    const av = a ? BLAST_ORDER[a] : 0;
    const bv = b ? BLAST_ORDER[b] : 0;
    return av - bv;
  }

  /** Enumerate all declarations — for the dashboard + HITL policy init. */
  all(): BlastDeclaration[] {
    return Array.from(this.byKey.values());
  }

  clear(): void {
    this.byKey.clear();
  }

  clearAgent(agentName: string): void {
    const prefix = `${agentName}::`;
    for (const key of this.byKey.keys()) {
      if (key.startsWith(prefix)) this.byKey.delete(key);
    }
  }

  get size(): number {
    return this.byKey.size;
  }
}

export const defaultBlastRegistry = new BlastRegistry();

/**
 * Register the blast-v1 extension interceptor. The registry is populated
 * separately by SkillBrokerPlugin when it parses agent cards — this
 * function just wires the stamp-on-outbound behavior.
 */
export function registerBlastExtension(
  registry: BlastRegistry = defaultBlastRegistry,
): void {
  const interceptor: ExtensionInterceptor = {
    before(ctx: ExtensionContext): void {
      const decl = registry.get(ctx.agentName, ctx.skill);
      if (decl) {
        ctx.metadata["x-blast-radius"] = decl.radius;
      }
    },
    // no after() — blast is a declaration, not an observation
  };

  defaultExtensionRegistry.register({
    uri: BLAST_URI,
    interceptor,
    description:
      "Blast v1: per-skill effect-scope declaration (self/project/repo/fleet/public); planner + HITL policy read from the registry",
  });
}
