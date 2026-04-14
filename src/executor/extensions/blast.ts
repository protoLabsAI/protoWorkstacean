/**
 * Blast-radius v1 extension — registers an interceptor that:
 *
 *   before(ctx): stamps the current skill name onto outbound metadata so the
 *     agent knows which skill is being invoked and can include its declared
 *     blast radius in its response.
 *
 *   after(ctx, result): reads the agent's blast radius declaration from the
 *     terminal artifact's structured data and publishes a `skill.blast.observed`
 *     event so the GOAP planner can apply stricter HITL gates to higher-blast
 *     skills regardless of goal-level config.
 *
 * Call `registerBlastExtension(bus)` once at startup (e.g. in src/index.ts)
 * to wire this extension into the defaultExtensionRegistry.
 *
 * Blast radius levels (ordered from lowest to highest impact):
 *   "self"    — affects only the current agent process
 *   "project" — affects the current project
 *   "repo"    — affects the repository
 *   "fleet"   — affects the entire agent fleet
 *   "public"  — affects external / public systems
 *
 * Extension URI: https://protolabs.ai/a2a/ext/blast-v1
 */

import type { EventBus } from "../../../lib/types.ts";
import {
  defaultExtensionRegistry,
  type ExtensionInterceptor,
  type ExtensionContext,
} from "../extension-registry.ts";

export const BLAST_URI = "https://protolabs.ai/a2a/ext/blast-v1";

/** Ordered blast radius levels from narrowest to broadest impact. */
export type BlastRadius = "self" | "project" | "repo" | "fleet" | "public";

/**
 * Blast radius declaration for a single skill execution as returned by the
 * agent in the terminal artifact's structured data under `x-blast-radius`.
 */
export interface SkillBlastDeclaration {
  /** Blast radius level declared by the skill. */
  radius: BlastRadius;
  /** Human-readable description of what the skill affects at this radius. */
  description?: string;
}

/**
 * Payload published on `skill.blast.observed` after each skill execution
 * that returns blast-radius data.
 */
export interface SkillBlastPayload {
  /** Agent that produced this declaration. */
  source: string;
  /** Skill that was executed. */
  skill: string;
  /** Declared blast radius from the terminal artifact. */
  blast: SkillBlastDeclaration;
}

/**
 * Creates and registers the blast-radius interceptor with `defaultExtensionRegistry`.
 *
 * Must be called once at startup with a live EventBus reference so the `after`
 * hook can publish `skill.blast.observed`.
 */
export function registerBlastExtension(bus: EventBus): void {
  const interceptor: ExtensionInterceptor = {
    before(ctx: ExtensionContext): void {
      // Stamp the skill name onto outbound metadata so the agent knows which
      // skill is being invoked and can include its blast radius declaration
      // in its response.
      ctx.metadata["x-blast-radius-skill"] = ctx.skill;
    },

    after(
      ctx: ExtensionContext,
      result: { text: string; data?: Record<string, unknown> },
    ): void {
      const blastData = result.data?.["x-blast-radius"] as
        | SkillBlastDeclaration
        | undefined;

      if (!blastData?.radius) return;

      const topic = "skill.blast.observed";
      bus.publish(topic, {
        id: crypto.randomUUID(),
        correlationId: ctx.correlationId,
        topic,
        timestamp: Date.now(),
        payload: {
          source: ctx.agentName,
          skill: ctx.skill,
          blast: blastData,
        } satisfies SkillBlastPayload,
      });
    },
  };

  defaultExtensionRegistry.register({
    uri: BLAST_URI,
    interceptor,
    description:
      "Blast-radius v1: stamps skill name on outbound metadata and publishes skill.blast.observed after execution",
  });
}
