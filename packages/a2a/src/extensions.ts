/**
 * The four protoLabs A2A extensions.
 *
 * Every protoLabs agent reports structured telemetry alongside its task result
 * by attaching custom A2A DataParts to its terminal Task's artifacts. Each
 * extension is identified by a stable MIME type carried in the part's
 * `metadata.mimeType`; the structured payload lives in `content.value`.
 *
 * This module is the single source of truth for those contracts in TypeScript.
 * It carries, for each extension:
 *   - the MIME constant (the on-wire discriminator),
 *   - the payload type,
 *   - an `emit*` helper that builds a spec-correct 1.0 DataPart,
 *   - a `parse*` helper that extracts the payload from a parts array.
 *
 * The Python layer (`protolabs-a2a`) mirrors these exact shapes.
 *
 * --- The wire shape (A2A 1.0, member-discriminated Part) ---
 *
 *   {
 *     content:  { $case: "data", value: <payload> },
 *     metadata: { mimeType: "<MIME constant>" },
 *     filename: "",
 *     mediaType: "application/json"
 *   }
 *
 * Note the deliberate split: the SDK's own `mediaType` field stays
 * "application/json" (it is the transport-level media type); the protoLabs
 * extension discriminator rides on the application-level `metadata.mimeType`.
 * Consumers match on `metadata.mimeType`, never on `mediaType`. This keeps the
 * extension contract orthogonal to the SDK's Part typing and unchanged by the
 * 0.3 → 1.0 migration.
 */

import type { Part } from "@a2a-js/sdk";
import { dataPart, partData } from "./parts.ts";

// --------------------------------------------------------------------------
// Extension URIs (declared in the AgentCard's capabilities.extensions[])
// --------------------------------------------------------------------------

/**
 * The canonical extension URIs the fleet declares in its AgentCard
 * `capabilities.extensions[]`. These are the *advertised* identifiers; the
 * per-part *discriminator* is the MIME constant below. Both forms are stable.
 */
export const COST_V1_EXTENSION_URI = "https://proto-labs.ai/a2a/ext/cost-v1";
export const CONFIDENCE_V1_EXTENSION_URI = "https://proto-labs.ai/a2a/ext/confidence-v1";
export const WORLDSTATE_DELTA_V1_EXTENSION_URI = "https://proto-labs.ai/a2a/ext/worldstate-delta-v1";
export const TOOL_CALL_V1_EXTENSION_URI = "https://proto-labs.ai/a2a/ext/tool-call-v1";

// --------------------------------------------------------------------------
// cost-v1 — observed skill cost + duration
// --------------------------------------------------------------------------

/** Registered MIME type (DataPart discriminator) for cost-v1 parts. */
export const COST_V1_MIME_TYPE = "application/vnd.protolabs.cost-v1+json";

/** Token usage snapshot — Anthropic-shaped but framework-agnostic. */
export interface CostArtifactUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** The payload of a DataPart with `metadata.mimeType === COST_V1_MIME_TYPE`. */
export interface CostArtifactData {
  usage: CostArtifactUsage;
  /** Wall-clock duration in milliseconds. */
  durationMs?: number;
  /** Dollar cost. If omitted, the consumer can compute from tokens + rates. */
  costUsd?: number;
  /** Explicit success flag — overrides taskState when present. */
  success?: boolean;
}

/** Build a cost-v1 DataPart for a terminal Task's artifacts. */
export function emitCost(data: CostArtifactData): Part {
  return dataPart(data, COST_V1_MIME_TYPE);
}

/** Extract the first cost-v1 payload from a parts array, or undefined. */
export function parseCost(parts: Part[]): CostArtifactData | undefined {
  return dataPartByMime<CostArtifactData>(parts, COST_V1_MIME_TYPE);
}

// --------------------------------------------------------------------------
// confidence-v1 — self-reported confidence
// --------------------------------------------------------------------------

/** Registered MIME type (DataPart discriminator) for confidence-v1 parts. */
export const CONFIDENCE_V1_MIME_TYPE = "application/vnd.protolabs.confidence-v1+json";

/** The payload of a DataPart with `metadata.mimeType === CONFIDENCE_V1_MIME_TYPE`. */
export interface ConfidenceArtifactData {
  /** Self-reported confidence in [0, 1]. Consumers defensively clamp out-of-range. */
  confidence: number;
  /** Free-text reasoning — surfaced in calibration views. */
  explanation?: string;
  /** Explicit success flag — overrides taskState when present. */
  success?: boolean;
}

/** Build a confidence-v1 DataPart for a terminal Task's artifacts. */
export function emitConfidence(data: ConfidenceArtifactData): Part {
  return dataPart(data, CONFIDENCE_V1_MIME_TYPE);
}

/** Extract the first confidence-v1 payload from a parts array, or undefined. */
export function parseConfidence(parts: Part[]): ConfidenceArtifactData | undefined {
  return dataPartByMime<ConfidenceArtifactData>(parts, CONFIDENCE_V1_MIME_TYPE);
}

// --------------------------------------------------------------------------
// worldstate-delta-v1 — observed world-state mutations
// --------------------------------------------------------------------------

/** Registered MIME type (DataPart discriminator) for worldstate-delta parts. */
export const WORLDSTATE_DELTA_MIME_TYPE = "application/vnd.protolabs.worldstate-delta+json";

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

/** The payload of a DataPart with `metadata.mimeType === WORLDSTATE_DELTA_MIME_TYPE`. */
export interface WorldStateDeltaArtifactData {
  deltas: WorldStateDeltaEntry[];
}

/** Build a worldstate-delta-v1 DataPart for a terminal Task's artifacts. */
export function emitWorldStateDelta(data: WorldStateDeltaArtifactData): Part {
  return dataPart(data, WORLDSTATE_DELTA_MIME_TYPE);
}

/** Extract the first worldstate-delta-v1 payload from a parts array, or undefined. */
export function parseWorldStateDelta(parts: Part[]): WorldStateDeltaArtifactData | undefined {
  return dataPartByMime<WorldStateDeltaArtifactData>(parts, WORLDSTATE_DELTA_MIME_TYPE);
}

// --------------------------------------------------------------------------
// tool-call-v1 — per-tool progress frames
// --------------------------------------------------------------------------

/** Registered MIME type (DataPart discriminator) for tool-call-v1 parts. */
export const TOOL_CALL_V1_MIME_TYPE = "application/vnd.protolabs.tool-call-v1+json";

/**
 * A single tool-call progress frame. Agents emit these (typically as streamed
 * artifact-update DataParts) so the hub can render which tool the agent is
 * running mid-task. The frame describes one tool invocation; multiple frames
 * with the same `toolCallId` describe its lifecycle (started → completed).
 */
export interface ToolCallArtifactData {
  /** Stable id correlating frames of the same invocation. */
  toolCallId: string;
  /** Tool name (e.g. "github_create_issue"). */
  name: string;
  /** Lifecycle phase of this frame. */
  phase: "started" | "completed" | "failed";
  /** Tool arguments (present on the "started" frame). */
  args?: unknown;
  /** Tool result summary (present on the "completed" frame). */
  result?: unknown;
  /** Error message (present on the "failed" frame). */
  error?: string;
}

/** Build a tool-call-v1 DataPart (typically a streamed artifact-update part). */
export function emitToolCall(data: ToolCallArtifactData): Part {
  return dataPart(data, TOOL_CALL_V1_MIME_TYPE);
}

/** Extract the first tool-call-v1 payload from a parts array, or undefined. */
export function parseToolCall(parts: Part[]): ToolCallArtifactData | undefined {
  return dataPartByMime<ToolCallArtifactData>(parts, TOOL_CALL_V1_MIME_TYPE);
}

// --------------------------------------------------------------------------
// Shared scan primitive
// --------------------------------------------------------------------------

/**
 * Scan a parts array for a structured DataPart whose `metadata.mimeType`
 * matches the given protoLabs extension MIME. A2A 1.0: the structured payload
 * lives in `part.content.value` (when `$case === "data"`); the discriminator
 * stays in `part.metadata.mimeType` (application metadata, NOT the SDK's
 * `mediaType`). Returns the first match's payload, or undefined.
 */
export function dataPartByMime<T>(parts: Part[], mimeType: string): T | undefined {
  for (const part of parts) {
    const value = partData(part);
    if (value !== undefined && part.metadata?.["mimeType"] === mimeType) {
      return value as T;
    }
  }
  return undefined;
}
