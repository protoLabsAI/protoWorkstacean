/**
 * Effect-domain v1 extension — registers an interceptor that:
 *
 *   before(ctx): stamps the current skill name onto outbound metadata so the
 *     agent can see which skill is being invoked and confirm the expected effects.
 *
 *   after(ctx, result): reads the agent's actual delta from the terminal
 *     artifact's structured data and publishes a `world.state.delta` event so
 *     the GOAP planner can update its world-state snapshot without waiting for
 *     the next full poll.
 *
 * Call `registerEffectDomainExtension(bus)` once at startup (e.g. in src/index.ts)
 * to wire this extension into the defaultExtensionRegistry.
 *
 * Extension URI: https://protolabs.ai/a2a/ext/effect-domain-v1
 */

import type { EventBus } from "../../../lib/types.ts";
import {
  defaultExtensionRegistry,
  type ExtensionInterceptor,
  type ExtensionContext,
} from "../extension-registry.ts";

export const EFFECT_DOMAIN_URI = "https://protolabs.ai/a2a/ext/effect-domain-v1";

/** A single world-state mutation declared or observed for a skill execution. */
export interface EffectDomainDelta {
  /** Name of the world-state domain (e.g. "ci", "plane"). */
  domain: string;
  /** Dot-separated path into the domain's data object (e.g. "data.blockedPRs"). */
  path: string;
  /** Signed numeric change applied to the value at `path`. */
  delta: number;
  /** Planner weight in [0.0, 1.0]. */
  confidence: number;
}

/**
 * Payload published on `world.state.delta` after each skill execution that
 * returns effect-domain data.
 */
export interface WorldStateDeltaPayload {
  /** Agent that produced this delta. */
  source: string;
  /** Skill that was executed. */
  skill: string;
  /** Observed or declared deltas from the terminal artifact. */
  delta: EffectDomainDelta[];
}

/**
 * Creates and registers the effect-domain interceptor with `defaultExtensionRegistry`.
 *
 * Must be called once at startup with a live EventBus reference so the `after`
 * hook can publish `world.state.delta`.
 */
export function registerEffectDomainExtension(bus: EventBus): void {
  const interceptor: ExtensionInterceptor = {
    before(ctx: ExtensionContext): void {
      // Stamp the skill name onto outbound metadata so the agent knows which
      // skill is being invoked and can include effect confirmation in its response.
      ctx.metadata["x-effect-domain-skill"] = ctx.skill;
    },

    after(
      ctx: ExtensionContext,
      result: { text: string; data?: Record<string, unknown> },
    ): void {
      const effectData = result.data?.["x-effect-domain"] as
        | { delta?: EffectDomainDelta[] }
        | undefined;

      if (!effectData?.delta?.length) return;

      const topic = "world.state.delta";
      bus.publish(topic, {
        id: crypto.randomUUID(),
        correlationId: ctx.correlationId,
        topic,
        timestamp: Date.now(),
        payload: {
          source: ctx.agentName,
          skill: ctx.skill,
          delta: effectData.delta,
        } satisfies WorldStateDeltaPayload,
      });
    },
  };

  defaultExtensionRegistry.register({
    uri: EFFECT_DOMAIN_URI,
    interceptor,
    description:
      "Effect-domain v1: stamps skill name on outbound metadata and publishes world.state.delta after execution",
  });
}
