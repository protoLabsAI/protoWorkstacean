/**
 * Structured skill results.
 *
 * A skill that declares an `output_schema` emits its result not as free text
 * but as a structured A2A DataPart, carried on the **same wire** as the four
 * protoLabs extensions (cost / confidence / worldstate-delta / tool-call):
 *
 *   {
 *     content:  { $case: "data", value: <validated result object> },
 *     metadata: { mimeType: "application/vnd.protolabs.<skill>-result-vN+json" },
 *     filename: "",
 *     mediaType: "application/json"
 *   }
 *
 * The discriminator is the per-skill result MIME (advertised on the skill's
 * `output_modes` in the agent card); the payload is the structured object. The
 * Python layer (`protolabs-a2a`) mirrors this exact shape via
 * `emit_skill_result(obj, mime)`.
 *
 * This module is intentionally thin: `emitSkillResult` is a named wrapper over
 * the existing `dataPart()` machinery, and `submitToolName` encodes the
 * finalizer tool-name convention used by the runtime-local forced tool-call
 * enforcement path. The Part shape lives in `parts.ts`; this file does not
 * reinvent it.
 */

import type { Part } from "@a2a-js/sdk";
import { dataPart, partData } from "./parts.ts";

/**
 * Build a structured skill-result DataPart. A thin named wrapper over
 * `dataPart(obj, mime)` — the result rides the same wire as the cost-v1 /
 * confidence-v1 extensions, discriminated by `metadata.mimeType === mime`.
 *
 * @param obj  the validated structured result object
 * @param mime the skill's result MIME (e.g. application/vnd.protolabs.pr-diagnosis-v1+json)
 */
export function emitSkillResult(obj: unknown, mime: string): Part {
  return dataPart(obj, mime);
}

/**
 * Extract the structured skill-result payload from a parts array by MIME, or
 * undefined when no matching DataPart is present. Mirror of the extension
 * `parse*` helpers; consumers match on `metadata.mimeType`, never `mediaType`.
 */
export function readSkillResult<T>(parts: Part[], mime: string): T | undefined {
  for (const part of parts) {
    const value = partData(part);
    if (value !== undefined && part.metadata?.["mimeType"] === mime) {
      return value as T;
    }
  }
  return undefined;
}

/** Prefix every structured finalizer tool name carries. */
export const SUBMIT_TOOL_PREFIX = "submit_";

/**
 * The forced-finalizer tool-name convention. When a skill declares an
 * `output_schema`, the runtime binds a tool named `submit_<skill>` whose
 * parameters ARE the schema and forces `tool_choice` to it. Single source of
 * truth so the executor and any consumer agree on the name.
 */
export function submitToolName(skill: string): string {
  return `${SUBMIT_TOOL_PREFIX}${skill}`;
}

/** Matches a `submit_<skill>` finalizer tool name; capture group 1 is the skill. */
export const SUBMIT_TOOL_NAME_RE = /^submit_(.+)$/;
