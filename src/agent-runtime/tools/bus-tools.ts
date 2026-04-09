/**
 * Built-in workstacean bus tools.
 *
 * These are the workstacean-specific capabilities any agent can be granted.
 * They wrap the HTTP API (POST /publish, GET /api/world-state, etc.) so the
 * agent doesn't need direct bus access — the SDK MCP server bridges it.
 *
 * Tools are created via the SDK tool() factory so they can be:
 *   1. Bundled into a per-agent embedded MCP server (createSdkMcpServer)
 *   2. Exposed on the standalone MCP server (mcp/server.ts)
 *
 * The `baseUrl` parameter is injected at creation time — it points to the
 * running protoWorkstacean HTTP API (default: http://localhost:3000).
 */

import { tool } from "@protolabsai/sdk";
import { z } from "zod";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

async function apiGet(baseUrl: string, path: string, apiKey?: string): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["X-API-Key"] = apiKey;
  const resp = await fetch(`${baseUrl}${path}`, { headers });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function apiPost(
  baseUrl: string,
  path: string,
  body: unknown,
  apiKey?: string,
): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  const resp = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${await resp.text()}`);
  return resp.json();
}

export interface BusToolsOptions {
  /** Base URL of the protoWorkstacean HTTP API. Default: http://localhost:3000 */
  baseUrl?: string;
  /** Optional API key for authenticated endpoints. */
  apiKey?: string;
}

/**
 * Create all built-in bus tool definitions.
 * Call once at startup and register the returned array with ToolRegistry.
 */
export function createBusTools(opts: BusToolsOptions = {}) {
  const baseUrl = opts.baseUrl ?? "http://localhost:3000";
  const apiKey = opts.apiKey;

  const publishEvent = tool(
    "publish_event",
    "Publish an event to the protoWorkstacean event bus. Use this to trigger actions, " +
      "signal other agents, or inject messages into the system. " +
      "The projectSlug routes the event to the correct project's agents and board.",
    {
      topic: z.string().describe("Bus topic, e.g. 'agent.skill.request' or 'custom.my.event'"),
      payload: z.record(z.unknown()).describe("Event payload object"),
      projectSlug: z
        .string()
        .optional()
        .describe("Project slug for routing — routes to the correct agent/board"),
    },
    async ({ topic, payload, projectSlug }) => {
      try {
        const body = {
          topic,
          payload: projectSlug ? { ...payload, projectSlug } : payload,
          ...(projectSlug ? { source: { interface: "agent", projectSlug } } : {}),
        };
        const data = await apiPost(baseUrl, "/publish", body, apiKey);
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const getWorldState = tool(
    "get_world_state",
    "Read the current world state snapshot from the GOAP engine. " +
      "Returns all domains or a single one. Built-in domains: services (integration health), " +
      "agent_health (loaded agents and skills), flow (velocity/efficiency metrics).",
    {
      domain: z
        .string()
        .optional()
        .describe(
          "Optional domain filter — omit to get all domains",
        ),
    },
    async ({ domain }) => {
      try {
        const path = domain ? `/api/world-state/${domain}` : "/api/world-state";
        const data = await apiGet(baseUrl, path, apiKey);
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const getIncidents = tool(
    "get_incidents",
    "List all security and operational incidents from incidents.yaml.",
    {},
    async () => {
      try {
        const data = await apiGet(baseUrl, "/api/incidents", apiKey);
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const reportIncident = tool(
    "report_incident",
    "Report a new security or operational incident. This triggers the GOAP security pipeline: " +
      "Discord alert (prio 100) and a Quinn triage ceremony (prio 90).",
    {
      title: z.string().describe("Brief incident title"),
      severity: z
        .enum(["critical", "high", "medium", "low"])
        .describe("Incident severity level"),
      description: z.string().optional().describe("Optional detailed description"),
      affectedProjects: z
        .array(z.string())
        .optional()
        .describe("Affected project slugs"),
      projectSlug: z
        .string()
        .optional()
        .describe("Project slug for board routing"),
    },
    async ({ title, severity, description, affectedProjects, projectSlug }) => {
      try {
        const body: Record<string, unknown> = { title, severity };
        if (description) body.description = description;
        if (affectedProjects) body.affectedProjects = affectedProjects;
        if (projectSlug) body.projectSlug = projectSlug;
        const data = await apiPost(baseUrl, "/api/incidents", body, apiKey);
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const getCeremonies = tool(
    "get_ceremonies",
    "List all configured ceremonies from workspace/ceremonies/*.yaml.",
    {},
    async () => {
      try {
        const data = await apiGet(baseUrl, "/api/ceremonies", apiKey);
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const runCeremony = tool(
    "run_ceremony",
    "Manually trigger a named ceremony. The ceremony must exist in workspace/ceremonies/.",
    {
      ceremonyId: z
        .string()
        .regex(/^[\w.\-]+$/, "Must be alphanumeric with dashes/dots")
        .describe("Ceremony ID, e.g. 'board.cleanup' or 'board.health'"),
    },
    async ({ ceremonyId }) => {
      try {
        const data = await apiPost(baseUrl, `/api/ceremonies/${ceremonyId}/run`, {}, apiKey);
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return [publishEvent, getWorldState, getIncidents, reportIncident, getCeremonies, runCeremony];
}

/**
 * Names of all built-in bus tools.
 * Use this to construct the 'tools' whitelist in an agent YAML.
 */
export const BUS_TOOL_NAMES = [
  "publish_event",
  "get_world_state",
  "get_incidents",
  "report_incident",
  "get_ceremonies",
  "run_ceremony",
] as const;

export type BusToolName = (typeof BUS_TOOL_NAMES)[number];
