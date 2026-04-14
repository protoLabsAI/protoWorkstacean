/**
 * Confidence v1 extension — registers an interceptor that:
 *
 *   after(ctx, result): reads the agent's confidence score from the terminal
 *     artifact's structured data and publishes a `world.action.confidence`
 *     event so OutcomeAnalysisPlugin can weight failure signals accordingly.
 *
 * Agents include a confidence block in their terminal message data:
 *
 *   { "x-protolabs-confidence": { "confidence": 0.72, "explanation": "..." } }
 *
 * Call `registerConfidenceExtension(bus)` once at startup (e.g. in src/index.ts)
 * to wire this extension into the defaultExtensionRegistry.
 *
 * Extension URI: https://protolabs.ai/a2a/ext/x-protolabs/confidence-v1
 */

import type { EventBus } from "../../../lib/types.ts";
import {
  defaultExtensionRegistry,
  type ExtensionInterceptor,
  type ExtensionContext,
} from "../extension-registry.ts";
import type { WorldActionConfidencePayload } from "../../event-bus/payloads.ts";

export const CONFIDENCE_URI = "https://protolabs.ai/a2a/ext/x-protolabs/confidence-v1";

/**
 * Creates and registers the confidence interceptor with `defaultExtensionRegistry`.
 *
 * Must be called once at startup with a live EventBus reference so the `after`
 * hook can publish `world.action.confidence`.
 */
export function registerConfidenceExtension(bus: EventBus): void {
  const interceptor: ExtensionInterceptor = {
    after(
      ctx: ExtensionContext,
      result: { text: string; data?: Record<string, unknown> },
    ): void {
      const confidenceData = result.data?.["x-protolabs-confidence"] as
        | { confidence?: unknown; explanation?: unknown }
        | undefined;

      if (!confidenceData) return;

      const confidence = confidenceData.confidence;
      // Use !(>= && <=) rather than (< || >) to correctly reject NaN
      if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return;

      const explanation =
        typeof confidenceData.explanation === "string"
          ? confidenceData.explanation
          : undefined;

      const topic = "world.action.confidence";
      bus.publish(topic, {
        id: crypto.randomUUID(),
        correlationId: ctx.correlationId,
        topic,
        timestamp: Date.now(),
        payload: {
          source: ctx.agentName,
          skill: ctx.skill,
          confidence,
          ...(explanation !== undefined ? { explanation } : {}),
        } satisfies WorldActionConfidencePayload,
      });
    },
  };

  defaultExtensionRegistry.register({
    uri: CONFIDENCE_URI,
    interceptor,
    description:
      "Confidence v1: reads agent confidence from terminal artifact and publishes world.action.confidence",
  });
}
