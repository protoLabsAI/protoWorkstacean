/**
 * Blast-radius v1 extension — registers an interceptor that:
 *
 *   before(ctx): stamps the declared blast radius and HITL requirement for
 *     the current skill onto outbound metadata so agents and interceptors
 *     can see the execution scope.
 *
 *   after(ctx, result): publishes a `skill.blast.executed` event so the
 *     planner can audit high-blast executions and apply stricter HITL
 *     gates in future dispatches.
 *
 * Call `registerBlastV1Extension(bus)` once at startup (e.g. in src/index.ts)
 * to wire this extension into the defaultExtensionRegistry.
 *
 * Call `declareBlastRadius(agentName, skill, radius)` from SkillBrokerPlugin /
 * AgentRuntimePlugin when reading agent card extension params.
 *
 * Extension URI: https://protolabs.ai/a2a/ext/blast-v1
 */

import type { EventBus } from "../../../lib/types.ts";
import {
  defaultExtensionRegistry,
  type ExtensionInterceptor,
  type ExtensionContext,
} from "../extension-registry.ts";

export const BLAST_V1_URI = "https://protolabs.ai/a2a/ext/blast-v1";

/** Ordered from least to most impactful. */
export type BlastRadius = "self" | "project" | "repo" | "fleet" | "public";

const BLAST_ORDER: readonly BlastRadius[] = [
  "self",
  "project",
  "repo",
  "fleet",
  "public",
];

/** Blast radii that always require HITL, regardless of goal-level config. */
const HITL_REQUIRED_RADII = new Set<BlastRadius>(["fleet", "public"]);

/**
 * Returns the ordinal rank of a blast radius (higher = more impactful).
 * Useful for comparing two blast radii without string comparison.
 */
export function blastRadiusOrdinal(radius: BlastRadius): number {
  return BLAST_ORDER.indexOf(radius);
}

/**
 * Returns true if the given blast radius requires HITL approval before
 * the skill may execute, regardless of goal-level configuration.
 */
export function requiresHITL(radius: BlastRadius): boolean {
  return HITL_REQUIRED_RADII.has(radius);
}

// ── Per-agent, per-skill registry ─────────────────────────────────────────────

/**
 * Module-level map of `agentName:skill` → BlastRadius.
 * Populated by `declareBlastRadius()` during agent card discovery.
 */
const blastRadiusRegistry = new Map<string, BlastRadius>();

function registryKey(agentName: string, skill: string): string {
  return `${agentName}:${skill}`;
}

/**
 * Register the declared blast radius for a specific agent+skill pair.
 *
 * Called by SkillBrokerPlugin / AgentRuntimePlugin when reading agent
 * card extension params for `https://protolabs.ai/a2a/ext/blast-v1`.
 */
export function declareBlastRadius(
  agentName: string,
  skill: string,
  radius: BlastRadius,
): void {
  blastRadiusRegistry.set(registryKey(agentName, skill), radius);
}

/**
 * Return the declared blast radius for an agent+skill pair, or `undefined`
 * if no radius has been declared.
 */
export function getBlastRadius(
  agentName: string,
  skill: string,
): BlastRadius | undefined {
  return blastRadiusRegistry.get(registryKey(agentName, skill));
}

/**
 * Remove all declared blast radii for a given agent. Used when an agent
 * is unregistered or its card is refreshed.
 */
export function clearBlastRadii(agentName: string): void {
  for (const key of blastRadiusRegistry.keys()) {
    if (key.startsWith(`${agentName}:`)) {
      blastRadiusRegistry.delete(key);
    }
  }
}

/**
 * Clear the entire registry. Exposed for test isolation only.
 * @internal
 */
export function _clearAllBlastRadii(): void {
  blastRadiusRegistry.clear();
}

// ── Event payloads ─────────────────────────────────────────────────────────────

/**
 * Payload published on `skill.blast.executed` after each skill execution
 * for which a blast radius has been declared.
 */
export interface BlastExecutedPayload {
  /** Agent that executed this skill. */
  source: string;
  /** Skill that was executed. */
  skill: string;
  /** Declared blast radius for this skill. */
  radius: BlastRadius;
  /** Whether this radius mandates HITL regardless of goal config. */
  requiresHITL: boolean;
}

// ── Registration ───────────────────────────────────────────────────────────────

/**
 * Creates and registers the blast-v1 interceptor with `defaultExtensionRegistry`.
 *
 * Must be called once at startup with a live EventBus reference so the `after`
 * hook can publish `skill.blast.executed`.
 */
export function registerBlastV1Extension(bus: EventBus): void {
  const interceptor: ExtensionInterceptor = {
    before(ctx: ExtensionContext): void {
      const radius = getBlastRadius(ctx.agentName, ctx.skill);
      if (!radius) return;

      ctx.metadata["x-blast-v1-radius"] = radius;
      ctx.metadata["x-blast-v1-requires-hitl"] = requiresHITL(radius);
    },

    after(
      ctx: ExtensionContext,
      _result: { text: string; data?: Record<string, unknown> },
    ): void {
      const radius =
        getBlastRadius(ctx.agentName, ctx.skill) ??
        (ctx.metadata["x-blast-v1-radius"] as BlastRadius | undefined);

      if (!radius) return;

      const topic = "skill.blast.executed";
      bus.publish(topic, {
        id: crypto.randomUUID(),
        correlationId: ctx.correlationId,
        topic,
        timestamp: Date.now(),
        payload: {
          source: ctx.agentName,
          skill: ctx.skill,
          radius,
          requiresHITL: requiresHITL(radius),
        } satisfies BlastExecutedPayload,
      });
    },
  };

  defaultExtensionRegistry.register({
    uri: BLAST_V1_URI,
    interceptor,
    description:
      "Blast-radius v1: stamps skill blast radius on outbound metadata and publishes skill.blast.executed after execution",
  });
}
