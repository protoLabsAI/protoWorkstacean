/**
 * x-protolabs/worldstate-delta-v1 — artifact type for observed world-state mutations.
 *
 * Agents emit a `kind: "data"` artifact part with this MIME type as part of
 * their terminal Task to report state changes they have applied to shared
 * world-state domains. The effect-domain interceptor reads these parts and
 * publishes them on the `world.state.delta` bus topic so the GOAP planner
 * can update its world-state snapshot without waiting for the next full poll.
 *
 * MIME type: application/vnd.protolabs.worldstate-delta+json
 *
 * Artifact part shape (A2A DataPart):
 *   {
 *     kind: "data",
 *     data: WorldStateDeltaArtifactData,
 *     metadata: { mimeType: WORLDSTATE_DELTA_MIME_TYPE }
 *   }
 */

/** Registered MIME type for world-state delta artifact parts. */
export const WORLDSTATE_DELTA_MIME_TYPE =
  "application/vnd.protolabs.worldstate-delta+json";

/**
 * The mutation operation to apply to the target path.
 *
 *   "set"  — Replace the value at `path` with `value` (idempotent).
 *   "inc"  — Add `value` (a number) to the current value at `path`.
 *   "push" — Append `value` to the array at `path`.
 */
export type WorldStateDeltaOp = "set" | "inc" | "push";

/** A single observed mutation to a world-state domain. */
export interface WorldStateDeltaEntry {
  /** Name of the world-state domain (e.g. "ci", "github_issues"). */
  domain: string;
  /** Dot-separated path into the domain's data object (e.g. "data.blockedPRs"). */
  path: string;
  /** Operation to apply. */
  op: WorldStateDeltaOp;
  /** Value to set, increment by, or append. Must be a number for "inc". */
  value: unknown;
}

/**
 * The `data` payload of an artifact part with
 * `mimeType: WORLDSTATE_DELTA_MIME_TYPE`.
 */
export interface WorldStateDeltaArtifactData {
  deltas: WorldStateDeltaEntry[];
}
