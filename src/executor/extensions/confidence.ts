/**
 * Confidence v1 extension — registers an interceptor that reads the agent's
 * self-reported confidence score from the terminal artifact's structured data
 * and publishes a `world.action.confidence` event so OutcomeAnalysisPlugin
 * can weight failure signals by confidence.
 *
 * A high-confidence bad outcome is a stronger signal that the action needs
 * attention than a low-confidence one (where the agent itself was uncertain).
 *
 * Agents include their confidence in the terminal message's structured data:
 *
 *   result.data["x-confidence"] = {
 *     confidence: 0.72,       // [0.0, 1.0]
 *     explanation: "..."      // optional human-readable rationale
 *   }
 *
 * Call `registerConfidenceExtension(bus)` once at startup (e.g. in src/index.ts)
 * to wire this extension into the defaultExtensionRegistry.
 *
 * Extension URI: https://protolabs.ai/a2a/ext/confidence-v1
 */

import type { EventBus } from "../../../lib/types.ts";
import {
  defaultExtensionRegistry,
  type ExtensionInterceptor,
  type ExtensionContext,
} from "../extension-registry.ts";

export const CONFIDENCE_URI = "https://protolabs.ai/a2a/ext/confidence-v1";

/** Confidence score attached by the agent to its terminal message data. */
export interface AgentConfidence {
  /** Self-reported confidence in the outcome, in [0.0, 1.0]. */
  confidence: number;
  /** Optional human-readable explanation of the confidence score. */
  explanation?: string;
}

/** Payload published on `world.action.confidence` after each skill execution. */
export interface ActionConfidencePayload {
  /** Trace ID propagated from the originating skill dispatch. */
  correlationId: string;
  /** Agent that reported this confidence. */
  agentName: string;
  /** Skill that was executed. */
  skill: string;
  /** Self-reported confidence in the outcome, in [0.0, 1.0]. */
  confidence: number;
  /** Optional human-readable explanation of the confidence score. */
  explanation?: string;
}

/** @deprecated Use ActionConfidencePayload. */
export type ConfidenceReportedPayload = ActionConfidencePayload;

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
      const conf = result.data?.["x-confidence"] as AgentConfidence | undefined;
      if (!conf || typeof conf.confidence !== "number") return;

      const confidence = Math.max(0, Math.min(1, conf.confidence));

      const topic = "world.action.confidence";
      bus.publish(topic, {
        id: crypto.randomUUID(),
        correlationId: ctx.correlationId,
        topic,
        timestamp: Date.now(),
        payload: {
          correlationId: ctx.correlationId,
          agentName: ctx.agentName,
          skill: ctx.skill,
          confidence,
          explanation: conf.explanation,
        } satisfies ActionConfidencePayload,
      });
    },
  };

  defaultExtensionRegistry.register({
    uri: CONFIDENCE_URI,
    interceptor,
    description:
      "Confidence v1: reads agent self-reported confidence from terminal message and publishes world.action.confidence",
  });
}
