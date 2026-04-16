/**
 * HITL mode v1 extension — per-skill approval policy declared on the agent card.
 *
 * HITL is a gradient, not a binary. Skills span a range from fully autonomous
 * through post-hoc veto windows to compound multi-step gates. Declaring the
 * mode per-skill on the agent card lets the dispatcher + HITL plugin route
 * each invocation to the right flow without goal-level config.
 *
 * Like blast-v1 this is a read-side declaration: `before(ctx)` stamps the
 * declared mode on outbound metadata so downstream consumers (HITL plugin,
 * TaskTracker) can read it without a second lookup. No `after(ctx)` — mode
 * is policy, not observation.
 *
 * Extension URI: https://protolabs.ai/a2a/ext/hitl-mode-v1
 */

import {
  defaultExtensionRegistry,
  type ExtensionInterceptor,
  type ExtensionContext,
} from "../extension-registry.ts";

export const HITL_MODE_URI = "https://protolabs.ai/a2a/ext/hitl-mode-v1";

/**
 * Approval policy for a single skill. Ordered from least-gated to most-gated.
 *
 * - `autonomous`   — no human in the loop. Task runs, outcome is what it is.
 * - `notification` — runs autonomously; a read-only notification is rendered
 *   to the originating surface (Discord, Plane) for awareness.
 * - `veto`         — short TTL window after dispatch where a human can cancel
 *   before side effects complete (via `tasks/cancel`). Auto-approved on TTL.
 * - `gated`        — blocking `input-required` before any side effect. No
 *   auto-approve; execution halts until a decision.
 * - `compound`     — multi-checkpoint gated. Agent emits multiple
 *   `input-required` states across the task lifecycle (draft → review →
 *   publish); each one requires its own decision.
 */
export type HitlMode =
  | "autonomous"
  | "notification"
  | "veto"
  | "gated"
  | "compound";

export const HITL_MODE_ORDER: Record<HitlMode, number> = {
  autonomous: 0,
  notification: 1,
  veto: 2,
  gated: 3,
  compound: 4,
};

export interface HitlModeDeclaration {
  agentName: string;
  skill: string;
  mode: HitlMode;
  /** Per-skill TTL for veto mode, in ms. Ignored for other modes. */
  vetoTtlMs?: number;
  /**
   * Who answers `input-required` prompts. `"operator"` forces the prompt
   * straight to the human renderer chain (Discord, etc.), bypassing the
   * dispatching-agent caller-first chain. Absent means caller-first (the
   * default): the dispatching agent gets the first shot via a chat skill
   * invocation, and only falls back to the human if the dispatcher can't
   * answer or doesn't reply within a TTL.
   */
  reviewer?: "operator";
  /** Optional human-readable reason for the declared mode. */
  note?: string;
}

/**
 * Registry of per-(agent, skill) HITL mode declarations. Populated at agent
 * card ingestion time by SkillBrokerPlugin, consulted at dispatch time by
 * SkillDispatcher / HITLPlugin to decide gating behavior.
 */
export class HitlModeRegistry {
  private readonly byKey = new Map<string, HitlModeDeclaration>();

  static key(agentName: string, skill: string): string {
    return `${agentName}::${skill}`;
  }

  declare(decl: HitlModeDeclaration): void {
    this.byKey.set(HitlModeRegistry.key(decl.agentName, decl.skill), decl);
  }

  get(agentName: string, skill: string): HitlModeDeclaration | undefined {
    return this.byKey.get(HitlModeRegistry.key(agentName, skill));
  }

  /** Resolve with a fallback default. `autonomous` is the safe default —
   *  the planner caller decides whether to bump the mode based on blast. */
  resolveMode(agentName: string, skill: string, fallback: HitlMode = "autonomous"): HitlMode {
    return this.get(agentName, skill)?.mode ?? fallback;
  }

  /** Numeric comparison — higher == more gated. Unknown treats as autonomous. */
  compare(a: HitlMode | undefined, b: HitlMode | undefined): number {
    const av = a ? HITL_MODE_ORDER[a] : 0;
    const bv = b ? HITL_MODE_ORDER[b] : 0;
    return av - bv;
  }

  all(): HitlModeDeclaration[] {
    return Array.from(this.byKey.values());
  }

  clear(): void {
    this.byKey.clear();
  }

  /** Drop every declaration for a given agent. Used on card-refresh so deletions propagate. */
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

export const defaultHitlModeRegistry = new HitlModeRegistry();

/**
 * Register the hitl-mode-v1 extension interceptor. The registry is populated
 * separately by SkillBrokerPlugin when it parses agent cards.
 */
export function registerHitlModeExtension(
  registry: HitlModeRegistry = defaultHitlModeRegistry,
): void {
  const interceptor: ExtensionInterceptor = {
    before(ctx: ExtensionContext): void {
      const decl = registry.get(ctx.agentName, ctx.skill);
      if (decl) {
        ctx.metadata["x-hitl-mode"] = decl.mode;
        if (decl.vetoTtlMs !== undefined) {
          ctx.metadata["x-hitl-veto-ttl-ms"] = decl.vetoTtlMs;
        }
      }
    },
    // no after() — mode is policy, not observation
  };

  defaultExtensionRegistry.register({
    uri: HITL_MODE_URI,
    interceptor,
    description:
      "HITL mode v1: per-skill approval policy (autonomous/notification/veto/gated/compound); HITL plugin reads from the registry",
  });
}
