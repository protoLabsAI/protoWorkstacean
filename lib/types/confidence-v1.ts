/**
 * x-protolabs/confidence-v1 — artifact type for self-reported confidence.
 *
 * Agents emit a `kind: "data"` artifact part with this MIME type on their
 * terminal Task to report how confident they are in the result. The
 * confidence-v1 interceptor reads these fields off `result.data` (flattened
 * by A2AExecutor), records a sample in `defaultConfidenceStore`, and emits
 * calibration warnings when high-confidence tasks fail.
 *
 * MIME type: application/vnd.protolabs.confidence-v1+json
 *
 * Artifact part shape (A2A DataPart):
 *   {
 *     kind: "data",
 *     data: ConfidenceArtifactData,
 *     metadata: { mimeType: CONFIDENCE_V1_MIME_TYPE }
 *   }
 */

/** Registered MIME type for confidence-v1 artifact parts. */
export const CONFIDENCE_V1_MIME_TYPE =
  "application/vnd.protolabs.confidence-v1+json";

/**
 * The `data` payload of an artifact part with
 * `mimeType: CONFIDENCE_V1_MIME_TYPE`.
 */
export interface ConfidenceArtifactData {
  /** Self-reported confidence in [0, 1]. Consumers defensively clamp out-of-range. */
  confidence: number;
  /** Free-text reasoning — surfaced in calibration views. */
  explanation?: string;
  /** Explicit success flag — overrides taskState when present. */
  success?: boolean;
}
