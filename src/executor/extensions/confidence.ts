/**
 * Confidence v1 extension — captures the agent's self-reported confidence
 * in its output so OutcomeAnalysis can weight failure/success signals by
 * how sure the agent was.
 *
 * A high-confidence failure is a stronger signal than a low-confidence one;
 * a low-confidence success shouldn't get the same weight as a high-confidence
 * one in aggregate success-rate calculations. Arc 6.4's planner ranking
 * reads from here when breaking ties between candidate skills.
 *
 *   before(ctx): stamps `x-confidence-skill` onto outbound metadata so the
 *     agent can include a confidence score in its terminal message.
 *
 *   after(ctx, result): reads `result.data.confidence` (0.0–1.0) and
 *     `result.data.confidenceExplanation` (optional string), records a
 *     ConfidenceSample, publishes `autonomous.confidence.{systemActor}.{skill}`
 *     for observability.
 *
 * Extension URI: https://proto-labs.ai/a2a/ext/confidence-v1
 */

import type { EventBus } from "../../../lib/types.ts";
import {
  defaultExtensionRegistry,
  type ExtensionInterceptor,
  type ExtensionContext,
} from "../extension-registry.ts";

export const CONFIDENCE_URI = "https://proto-labs.ai/a2a/ext/confidence-v1";

/** One observed confidence score from a completed task. */
export interface ConfidenceSample {
  systemActor: string;
  agentName: string;
  skill: string;
  /** Agent-reported confidence in the correctness of its output, 0.0–1.0. */
  confidence: number;
  /** Optional short free-text explanation from the agent. */
  explanation?: string;
  /** Whether the task itself succeeded. */
  success: boolean;
  completedAt: number;
  correlationId: string;
}

/** Aggregated confidence statistics for a (agent, skill) pair. */
export interface ConfidenceSummary {
  agentName: string;
  skill: string;
  sampleCount: number;
  /** Average confidence across recent samples. */
  avgConfidence: number;
  /** Average confidence for samples that succeeded. */
  avgConfidenceOnSuccess: number;
  /** Average confidence for samples that failed. */
  avgConfidenceOnFailure: number;
  /** Count of high-confidence-but-failed samples — a calibration warning. */
  highConfFailures: number;
}

const HIGH_CONFIDENCE_THRESHOLD = 0.8;

/**
 * Rolling confidence store. In-memory by design — observational telemetry,
 * not durable data. A later persistence layer is a separate concern.
 */
export class ConfidenceStore {
  private readonly samples = new Map<string, ConfidenceSample[]>();
  private readonly maxPerKey: number;

  constructor(maxPerKey = 200) {
    this.maxPerKey = maxPerKey;
  }

  static key(agentName: string, skill: string): string {
    return `${agentName}::${skill}`;
  }

  record(sample: ConfidenceSample): void {
    const k = ConfidenceStore.key(sample.agentName, sample.skill);
    const arr = this.samples.get(k) ?? [];
    arr.push(sample);
    if (arr.length > this.maxPerKey) arr.splice(0, arr.length - this.maxPerKey);
    this.samples.set(k, arr);
  }

  summary(agentName: string, skill: string): ConfidenceSummary | undefined {
    const arr = this.samples.get(ConfidenceStore.key(agentName, skill));
    if (!arr || arr.length === 0) return undefined;
    const n = arr.length;
    const successes = arr.filter(s => s.success);
    const failures = arr.filter(s => !s.success);
    const avg = (xs: ConfidenceSample[]): number =>
      xs.length === 0 ? 0 : xs.reduce((a, s) => a + s.confidence, 0) / xs.length;
    return {
      agentName,
      skill,
      sampleCount: n,
      avgConfidence: avg(arr),
      avgConfidenceOnSuccess: avg(successes),
      avgConfidenceOnFailure: avg(failures),
      highConfFailures: failures.filter(s => s.confidence >= HIGH_CONFIDENCE_THRESHOLD).length,
    };
  }

  allSummaries(): ConfidenceSummary[] {
    return Array.from(this.samples.keys())
      .map(k => {
        const [agentName, skill] = k.split("::");
        return this.summary(agentName, skill);
      })
      .filter((s): s is ConfidenceSummary => !!s);
  }

  get size(): number {
    return this.samples.size;
  }
}

export const defaultConfidenceStore = new ConfidenceStore();

/**
 * Registers the confidence interceptor with `defaultExtensionRegistry`.
 * Call once at startup with a live EventBus reference.
 */
export function registerConfidenceExtension(
  bus: EventBus,
  store: ConfidenceStore = defaultConfidenceStore,
): void {
  const interceptor: ExtensionInterceptor = {
    before(ctx: ExtensionContext): void {
      ctx.metadata["x-confidence-skill"] = ctx.skill;
    },

    after(
      ctx: ExtensionContext,
      result: { text: string; data?: Record<string, unknown> },
    ): void {
      // Agent is expected to set these on the terminal message's data part.
      const raw = result.data?.confidence;
      if (typeof raw !== "number") return;
      // Clamp to [0, 1] defensively — the spec says agents should stay in
      // range but we don't want a bad payload to poison stats.
      const confidence = Math.max(0, Math.min(1, raw));
      const explanation = typeof result.data?.confidenceExplanation === "string"
        ? (result.data.confidenceExplanation as string)
        : undefined;
      const success = result.data?.success !== false;
      const systemActor = typeof ctx.metadata["systemActor"] === "string"
        ? (ctx.metadata["systemActor"] as string)
        : "user";

      const sample: ConfidenceSample = {
        systemActor,
        agentName: ctx.agentName,
        skill: ctx.skill,
        confidence,
        explanation,
        success,
        completedAt: Date.now(),
        correlationId: ctx.correlationId,
      };
      store.record(sample);

      const topic = `autonomous.confidence.${systemActor}.${ctx.skill}`;
      bus.publish(topic, {
        id: crypto.randomUUID(),
        correlationId: ctx.correlationId,
        topic,
        timestamp: sample.completedAt,
        payload: sample,
      });
    },
  };

  defaultExtensionRegistry.register({
    uri: CONFIDENCE_URI,
    interceptor,
    description:
      "Confidence v1: captures agent-reported confidence (0.0–1.0), flags high-confidence failures for calibration, publishes autonomous.confidence.*",
  });
}
