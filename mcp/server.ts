/**
 * protoWorkstacean MCP Server
 *
 * Exposes the protoWorkstacean event bus and world state to Claude Code agents.
 * Register in .claude/mcp.json (project-local) or ~/.claude.json (global):
 *
 *   "workstacean": {
 *     "type": "stdio",
 *     "command": "bun",
 *     "args": ["run", "/path/to/protoWorkstacean/mcp/server.ts"],
 *     "env": {
 *       "WORKSTACEAN_URL": "http://localhost:3000",
 *       "WORKSTACEAN_API_KEY": "<key>"
 *     }
 *   }
 *
 * Tools use projectSlug to route events to the correct project's agents,
 * board, and Discord channels. Pass the slug from workspace/projects.yaml.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_URL = (process.env.WORKSTACEAN_URL ?? "http://localhost:3000").replace(/\/$/, "");
const API_KEY  = process.env.WORKSTACEAN_API_KEY ?? "";

// ── HTTP helper ────────────────────────────────────────────────────────────────

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function text(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// ── Server ─────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "workstacean",
  version: "0.1.0",
});

// ── health_check ───────────────────────────────────────────────────────────────

server.tool(
  "health_check",
  "Verify the protoWorkstacean bus is reachable and return its status.",
  {},
  async () => text(await api("GET", "/health")),
);

// ── get_world_state ────────────────────────────────────────────────────────────

server.tool(
  "get_world_state",
  "Read the current world state. Optionally scope to a single domain: services | board | ci | security | agent_health | portfolio.",
  {
    domain: z.enum(["services", "board", "ci", "security", "agent_health", "portfolio"])
      .optional()
      .describe("Domain to retrieve. Omit for the full world state."),
  },
  async ({ domain }) => {
    const path = domain ? `/api/world-state/${domain}` : "/api/world-state";
    return text(await api("GET", path));
  },
);

// ── report_incident ────────────────────────────────────────────────────────────

server.tool(
  "report_incident",
  "Report a security or operational incident to the bus. Triggers the GOAP security pipeline — world state updates immediately, goal evaluator fires, Discord alert and security-triage ceremony are dispatched.",
  {
    title: z.string().describe("Short description of the incident."),
    severity: z.enum(["critical", "high", "medium", "low"])
      .describe("Incident severity. Use 'critical' for active breaches or leaked secrets."),
    description: z.string().optional().describe("Full details: what happened, what was exposed, what mitigation is in place."),
    projectSlug: z.string().optional().describe("Slug from projects.yaml (e.g. protolabsai-protomaker). Routes the incident to the correct project's agents and board."),
    assignee: z.string().optional().describe("Agent name to assign triage to. Defaults to 'quinn'."),
  },
  async ({ title, severity, description, projectSlug, assignee }) => {
    return text(await api("POST", "/api/incidents", {
      title,
      severity,
      description,
      affectedProjects: projectSlug ? [projectSlug] : [],
      assignee: assignee ?? "quinn",
    }));
  },
);

// ── get_incidents ──────────────────────────────────────────────────────────────

server.tool(
  "get_incidents",
  "List all security/operational incidents. Optionally filter to a specific project.",
  {
    projectSlug: z.string().optional().describe("Filter to incidents affecting this project slug."),
    status: z.enum(["open", "investigating", "resolved", "all"]).optional()
      .describe("Filter by status. Defaults to all."),
  },
  async ({ projectSlug, status }) => {
    const result = await api("GET", "/api/incidents") as { success: boolean; data: Array<{
      id: string; status: string; affectedProjects?: string[];
    }> };
    let incidents = result.data ?? [];
    if (projectSlug) {
      incidents = incidents.filter(i => i.affectedProjects?.includes(projectSlug));
    }
    if (status && status !== "all") {
      incidents = incidents.filter(i => i.status === status);
    }
    return text({ ...result, data: incidents });
  },
);

// ── resolve_incident ───────────────────────────────────────────────────────────

server.tool(
  "resolve_incident",
  "Mark a security/operational incident as resolved. Publishes to the bus — world state security domain recollects immediately.",
  {
    id: z.string().describe("Incident ID (e.g. INC-001)."),
  },
  async ({ id }) => text(await api("POST", `/api/incidents/${id}/resolve`)),
);

// ── report_bug ─────────────────────────────────────────────────────────────────

server.tool(
  "report_bug",
  "Report a bug against a project. Routes to quinn's bug_triage skill via the skill broker. Quinn will triage, create a board issue, and escalate to ava if actionable.",
  {
    title: z.string().describe("Bug title."),
    description: z.string().describe("Steps to reproduce, expected vs actual behaviour, any relevant logs or stack traces."),
    projectSlug: z.string().describe("Slug from projects.yaml — determines which project board the issue is filed against and which agents are notified."),
    priority: z.enum(["urgent", "high", "medium", "low"]).optional()
      .describe("Priority hint passed to quinn. Defaults to 'medium'."),
  },
  async ({ title, description, projectSlug, priority }) => {
    return text(await api("POST", "/publish", {
      topic: "agent.skill.request",
      payload: {
        skill: "bug_triage",
        agentId: "quinn",
        projectSlug,
        context: {
          title,
          description,
          priority: priority ?? "medium",
          source: "mcp",
        },
      },
    }));
  },
);

// ── run_ceremony ───────────────────────────────────────────────────────────────

server.tool(
  "run_ceremony",
  "Manually trigger a named ceremony. The ceremony YAML must exist in workspace/ceremonies/.",
  {
    ceremonyId: z.string().describe("Ceremony ID (matches the YAML filename without extension, e.g. 'security-triage', 'board-health')."),
    projectSlug: z.string().optional().describe("Project context to include in the ceremony payload."),
  },
  async ({ ceremonyId, projectSlug }) => {
    // POST /api/ceremonies/:id/run expects an auth header — pass it via the helper
    const result = await api("POST", `/api/ceremonies/${ceremonyId}/run`, {
      projectSlug,
    });
    return text(result);
  },
);

// ── publish ────────────────────────────────────────────────────────────────────

server.tool(
  "publish",
  "Publish a raw event to the protoWorkstacean bus. Use this for advanced routing when no higher-level tool fits.",
  {
    topic: z.string().describe("Bus topic (e.g. 'agent.skill.request', 'message.inbound.discord.alert')."),
    payload: z.record(z.unknown()).describe("Event payload. Include 'projectSlug' to enable downstream project-scoped routing."),
    projectSlug: z.string().optional().describe("Convenience — merged into payload.projectSlug if provided."),
  },
  async ({ topic, payload, projectSlug }) => {
    return text(await api("POST", "/publish", {
      topic,
      payload: projectSlug ? { ...payload, projectSlug } : payload,
    }));
  },
);

// ── list_ceremonies ────────────────────────────────────────────────────────────

server.tool(
  "list_ceremonies",
  "List all available ceremonies defined in workspace/ceremonies/.",
  {},
  async () => text(await api("GET", "/api/ceremonies")),
);

// ── get_goals ─────────────────────────────────────────────────────────────────

server.tool(
  "get_goals",
  "List all GOAP goals and their current definitions. Use get_world_state to see which goals are currently violated.",
  {},
  async () => text(await api("GET", "/api/goals")),
);

// ── Start ──────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
