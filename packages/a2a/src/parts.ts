/**
 * A2A 1.0 Part helpers.
 *
 * In A2A 1.0 a Part is member-discriminated: `part.content` is a `$case`-tagged
 * union — `{ $case: "text", value } | { $case: "data", value } | { $case: "url",
 * value } | { $case: "raw", value }`. There is no top-level `kind`/`text`/`data`
 * (that was the 0.3 shape). These builders + readers keep the member
 * discrimination in one place so callers never hand-assemble a Part.
 */

import type { Part, Artifact } from "@a2a-js/sdk";

/** Build a text Part: `{ content: { $case: "text", value } }`. */
export function textPart(text: string): Part {
  return {
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

/**
 * Build a terminal text Artifact carrying an agent's final answer.
 *
 * A2A clients read a task's result from `task.artifacts[].parts[].text` — the
 * canonical "agent output" location. Emitting the answer as an artifact (in
 * addition to the completion `status.message`) is the fleet-canonical placement
 * so every A2A consumer gets the answer the same way, matching the Python
 * `protolabs-a2a` executor. (#773)
 */
export function textArtifact(text: string, opts: { artifactId?: string; name?: string } = {}): Artifact {
  return {
    artifactId: opts.artifactId ?? crypto.randomUUID(),
    name: opts.name ?? "answer",
    description: "",
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
  };
}

/**
 * Build a structured data Part: `{ content: { $case: "data", value } }`.
 *
 * The protoLabs convention carries the application-level discriminator in
 * `metadata.mimeType` (so consumers match the extension by MIME without
 * coupling to the SDK's transport-level `mediaType`, which stays
 * "application/json" for all our DataParts).
 */
export function dataPart(value: unknown, mimeType?: string): Part {
  return {
    content: { $case: "data", value },
    metadata: mimeType ? { mimeType } : undefined,
    filename: "",
    mediaType: "application/json",
  };
}

/** Pull the string value out of a text Part, or undefined if it isn't one. */
export function partText(part: Part): string | undefined {
  return part.content?.$case === "text" ? part.content.value : undefined;
}

/** Pull the structured value out of a data Part, or undefined if it isn't one. */
export function partData(part: Part): unknown {
  return part.content?.$case === "data" ? part.content.value : undefined;
}

/** Concatenate the text of every text Part in the array (non-text parts skipped). */
export function partsToText(parts: Part[]): string {
  return parts
    .map(partText)
    .filter((t): t is string => typeof t === "string")
    .join("");
}
