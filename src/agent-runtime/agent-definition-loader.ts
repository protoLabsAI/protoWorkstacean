/**
 * AgentDefinitionLoader — reads workspace/agents/*.yaml and returns
 * validated AgentDefinition objects.
 *
 * Each agent lives in its own YAML file so additions don't require editing
 * a shared registry. Files matching *.example are skipped (they are templates).
 *
 * Schema validation is strict: missing required fields throw so bad configs
 * surface at startup, not silently at dispatch time.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { AgentDefinition, AgentRole, AgentSkillDefinition, RawAgentYaml } from "./types.ts";

const VALID_ROLES: AgentRole[] = [
  "orchestrator",
  "qa",
  "devops",
  "content",
  "research",
  "general",
];

function isValidRole(r: unknown): r is AgentRole {
  return typeof r === "string" && VALID_ROLES.includes(r as AgentRole);
}

/**
 * Parse and validate a single raw YAML object into an AgentDefinition.
 * Throws a descriptive error if required fields are missing or invalid.
 */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function parseAgentYaml(raw: RawAgentYaml, fileName: string): AgentDefinition {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`[${fileName}] YAML must be a mapping object, got ${describeType(raw)}`);
  }
  if (!raw.name || typeof raw.name !== "string") {
    throw new Error(`[${fileName}] Missing or invalid 'name' field`);
  }
  if (!isValidRole(raw.role)) {
    throw new Error(
      `[${fileName}] Invalid 'role' "${raw.role}". Must be one of: ${VALID_ROLES.join(", ")}`,
    );
  }
  if (!raw.model || typeof raw.model !== "string") {
    throw new Error(`[${fileName}] Missing or invalid 'model' field`);
  }
  if (!raw.systemPrompt || typeof raw.systemPrompt !== "string") {
    throw new Error(`[${fileName}] Missing or invalid 'systemPrompt' field`);
  }

  const tools: string[] = Array.isArray(raw.tools)
    ? raw.tools.filter((t): t is string => typeof t === "string")
    : [];

  const allowedTools: string[] | undefined = Array.isArray((raw as Record<string, unknown>).allowedTools)
    ? ((raw as Record<string, unknown>).allowedTools as unknown[]).filter((t): t is string => typeof t === "string")
    : undefined;

  const excludeTools: string[] | undefined = Array.isArray((raw as Record<string, unknown>).excludeTools)
    ? ((raw as Record<string, unknown>).excludeTools as unknown[]).filter((t): t is string => typeof t === "string")
    : undefined;

  const canDelegate: string[] | undefined = Array.isArray(raw.canDelegate)
    ? raw.canDelegate.filter((d): d is string => typeof d === "string")
    : undefined;

  // -1 means unlimited (pass through as-is); any other non-positive value falls back to 10
  const maxTurns: number =
    typeof raw.maxTurns === "number" && (raw.maxTurns === -1 || raw.maxTurns > 0) ? raw.maxTurns : 10;

  const skills: AgentSkillDefinition[] = Array.isArray(raw.skills)
    ? raw.skills
        .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
        .map((s) => {
          const name = typeof s.name === "string" ? s.name : "";
          if (!name) return null;
          const keywords = Array.isArray(s.keywords)
            ? s.keywords.filter((k): k is string => typeof k === "string")
            : undefined;
        return {
            name,
            ...(typeof s.description === "string" ? { description: s.description } : {}),
            ...(keywords?.length ? { keywords } : {}),
            ...(typeof s.systemPromptOverride === "string"
              ? { systemPromptOverride: s.systemPromptOverride }
              : {}),
          };
        })
        .filter((s): s is AgentSkillDefinition => s !== null)
    : [];

  return {
    name: raw.name,
    role: raw.role,
    model: raw.model,
    systemPrompt: raw.systemPrompt,
    tools,
    ...(allowedTools?.length ? { allowedTools } : {}),
    ...(excludeTools?.length ? { excludeTools } : {}),
    ...(canDelegate !== undefined ? { canDelegate } : {}),
    maxTurns,
    skills,
  };
}

/**
 * Load all agent definitions from workspace/agents/*.yaml.
 *
 * - Files matching *.example are skipped.
 * - Files that fail to parse are logged and skipped (startup continues).
 * - Returns an empty array if the agents/ directory doesn't exist.
 */
export function loadAgentDefinitions(workspaceDir: string): AgentDefinition[] {
  const agentsDir = join(workspaceDir, "agents");
  if (!existsSync(agentsDir)) return [];

  const files = readdirSync(agentsDir).filter(
    (f) => (f.endsWith(".yaml") || f.endsWith(".yml")) && !f.endsWith(".example"),
  );

  const definitions: AgentDefinition[] = [];

  for (const file of files) {
    const filePath = join(agentsDir, file);
    try {
      const raw = parseYaml(readFileSync(filePath, "utf8")) as RawAgentYaml;
      const def = parseAgentYaml(raw, file);
      definitions.push(def);
      console.log(`[agent-runtime] Loaded agent "${def.name}" (${def.role}, model: ${def.model})`);
    } catch (err) {
      console.error(
        `[agent-runtime] Skipping ${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return definitions;
}
