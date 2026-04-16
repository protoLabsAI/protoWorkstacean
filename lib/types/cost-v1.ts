/**
 * x-protolabs/cost-v1 — artifact type for observed skill cost and duration.
 *
 * Agents emit a `kind: "data"` artifact part with this MIME type on their
 * terminal Task to report what the skill actually cost (token usage, wall
 * time, optional $USD). The cost-v1 interceptor reads these fields off
 * `result.data` (flattened by A2AExecutor), records a sample in
 * `defaultCostStore`, and publishes `autonomous.cost.*` for dashboards +
 * planner ranking.
 *
 * MIME type: application/vnd.protolabs.cost-v1+json
 *
 * Artifact part shape (A2A DataPart):
 *   {
 *     kind: "data",
 *     data: CostArtifactData,
 *     metadata: { mimeType: COST_V1_MIME_TYPE }
 *   }
 */

/** Registered MIME type for cost-v1 artifact parts. */
export const COST_V1_MIME_TYPE = "application/vnd.protolabs.cost-v1+json";

/** Token usage snapshot — Anthropic-shaped but framework-agnostic. */
export interface CostArtifactUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * The `data` payload of an artifact part with
 * `mimeType: COST_V1_MIME_TYPE`.
 */
export interface CostArtifactData {
  usage: CostArtifactUsage;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
  /** Dollar cost. If omitted, the consumer can compute from tokens + MODEL_RATES. */
  costUsd?: number;
  /** Explicit success flag — overrides taskState when present. */
  success?: boolean;
}
