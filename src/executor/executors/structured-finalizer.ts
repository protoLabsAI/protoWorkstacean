/**
 * Forced structured finalizer.
 *
 * When a dispatched skill declares an `outputSchema`, the DeepAgentExecutor
 * runs this finalizer AFTER the free-form reasoning loop. It is NOT a
 * `response_format` call (the reasoning backend ignores that): instead it binds
 * a single `submit_<skill>` tool whose parameters ARE the skill's JSON Schema,
 * forces `tool_choice` to that tool, and reads the structured args back out of
 * the model's tool call. The args are validated against a zod schema built from
 * the same JSON Schema; on validation failure the finalizer does ONE repair
 * retry (re-prompting with the validation error) before giving up.
 *
 * The seam: `bindTools([tool], { tool_choice })` on a ChatOpenAI is the only
 * LangGraph/LiteLLM-friendly way to force a tool call through our gateway
 * (the LangGraph prebuilt ReAct agent does not expose tool_choice forcing).
 * So the finalizer is a *direct* LLM call, separate from the ReAct loop — the
 * loop produces the analysis, the finalizer extracts the schema-shaped result.
 */

import { z } from "zod";
import { submitToolName } from "@protolabs/a2a";
import type { JsonSchema } from "../../agent-runtime/types.ts";

/**
 * A bound-tools LLM: takes the messages, returns the parsed tool-call args of
 * the forced `submit_<skill>` call. The executor supplies a real ChatOpenAI
 * binding; tests supply a stub. Returning `unknown` keeps validation honest —
 * the finalizer always re-validates regardless of who produced the args.
 */
export type ForcedToolCaller = (args: {
  /** System/instruction text for the finalizer turn. */
  system: string;
  /** The user content (analysis to distill into the schema). */
  user: string;
  /** The forced tool name (submit_<skill>). */
  toolName: string;
  /** The JSON-Schema parameters bound onto the forced tool. */
  parameters: JsonSchema;
}) => Promise<unknown>;

export interface FinalizerResult {
  /** The validated structured object. */
  value: unknown;
  /** True when the first attempt failed validation and the repair succeeded. */
  repaired: boolean;
}

/**
 * Build a zod schema from the JSON-Schema subset we accept for outputSchema.
 * Only the keywords the finalizer relies on are honored: type, properties,
 * required, items, enum. Unknown property keys pass through (`.passthrough()`
 * on objects) so the model can include extra context without tripping
 * validation — we validate the contract, not exhaustiveness.
 */
export function jsonSchemaToZod(schema: JsonSchema): z.ZodTypeAny {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const literals = schema.enum.map((v) => z.literal(v as z.Primitive)) as z.ZodTypeAny[];
    if (literals.length === 1) return literals[0]!;
    return z.union(literals as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  switch (schema.type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "integer":
      return z.number().int();
    case "boolean":
      return z.boolean();
    case "array":
      return z.array(schema.items ? jsonSchemaToZod(schema.items) : z.unknown());
    case "object":
    default: {
      const props = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, propSchema] of Object.entries(props)) {
        const built = jsonSchemaToZod(propSchema);
        shape[key] = required.has(key) ? built : built.optional();
      }
      return z.object(shape).passthrough();
    }
  }
}

/**
 * Run the forced structured finalizer for a skill with an outputSchema.
 *
 * @param skill      skill name (drives the submit_<skill> tool name)
 * @param outputSchema the skill's JSON Schema (bound as the tool's parameters)
 * @param analysis   the free-form analysis text the ReAct loop produced
 * @param call       the forced-tool caller (real binding in prod, stub in tests)
 * @returns the validated object + whether a repair was needed
 * @throws if both the first attempt and the single repair fail validation
 */
export async function runStructuredFinalizer(
  skill: string,
  outputSchema: JsonSchema,
  analysis: string,
  call: ForcedToolCaller,
): Promise<FinalizerResult> {
  const toolName = submitToolName(skill);
  const validator = jsonSchemaToZod(outputSchema);

  const system =
    `Distill the analysis below into a single ${toolName} tool call. ` +
    `Call the tool exactly once with arguments that satisfy its schema. ` +
    `Base every field on the analysis; do not invent facts.`;

  const first = await call({ system, user: analysis, toolName, parameters: outputSchema });
  const firstParse = validator.safeParse(first);
  if (firstParse.success) {
    return { value: firstParse.data, repaired: false };
  }

  // ONE repair retry — feed the validation error back so the model can fix it.
  const repairSystem =
    `${system}\n\nYour previous ${toolName} call failed schema validation with: ` +
    `${firstParse.error.message}\nReturn a corrected ${toolName} call.`;
  const second = await call({ system: repairSystem, user: analysis, toolName, parameters: outputSchema });
  const secondParse = validator.safeParse(second);
  if (secondParse.success) {
    return { value: secondParse.data, repaired: true };
  }

  throw new Error(
    `structured finalizer for "${skill}" failed validation after one repair: ${secondParse.error.message}`,
  );
}
