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
import { HttpClient } from "../../services/http-client.ts";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
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
  const http = new HttpClient({
    baseUrl,
    ...(apiKey ? { auth: { type: "api-key" as const, key: apiKey } } : {}),
  });

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
        const data = await http.post("/publish", body);
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
        const data = await http.get(path);
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
        const data = await http.get("/api/incidents");
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
        const data = await http.post("/api/incidents", {
          title,
          severity,
          ...(description ? { description } : {}),
          ...(affectedProjects ? { affectedProjects } : {}),
          ...(projectSlug ? { projectSlug } : {}),
        });
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const getProjects = tool(
    "get_projects",
    "List all registered projects from workspace/projects.yaml. Returns slug, title, " +
      "GitHub repo, default branch, status, and assigned agents for each project.",
    {},
    async () => {
      try {
        const data = await http.get("/api/projects");
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const getCiHealth = tool(
    "get_ci_health",
    "Get CI health across all registered projects — aggregate success rate, " +
      "per-repo breakdown, recent workflow run conclusions.",
    {},
    async () => {
      try {
        const data = await http.get("/api/ci-health");
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const getPrPipeline = tool(
    "get_pr_pipeline",
    "Get open PR status across all registered projects — total open, " +
      "conflicting, stale (>7d), failing checks, per-PR details.",
    {},
    async () => {
      try {
        const data = await http.get("/api/pr-pipeline");
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const getBranchDrift = tool(
    "get_branch_drift",
    "Get branch drift across all registered projects — commits ahead between dev, staging, and main.",
    {},
    async () => {
      try {
        const data = await http.get("/api/branch-drift");
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const getOutcomes = tool(
    "get_outcomes",
    "Get GOAP action dispatch outcomes — success/failure rates and recent history. " +
      "Use to introspect the self-healing flywheel's performance.",
    {},
    async () => {
      try {
        const data = await http.get("/api/outcomes");
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
        const data = await http.get("/api/ceremonies");
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
        const data = await http.post(`/api/ceremonies/${ceremonyId}/run`, {});
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ── Ava helm tools ────────────────────────────────────────────────────────

  const chatWithAgent = tool(
    "chat_with_agent",
    "Synchronous multi-turn conversation with another agent. Omit contextId to " +
      "start a new conversation. Pass contextId and taskId from a prior response to " +
      "continue. Set done=true on your final message to end the conversation cleanly. " +
      "Response includes taskState (completed, input-required, working, failed).",
    {
      agent: z.string().describe("Agent name: quinn, protomaker, protocontent, frank"),
      message: z.string().describe("What to say to the agent"),
      contextId: z.string().optional().describe("Context ID from a prior turn — omit for new conversation"),
      taskId: z.string().optional().describe("Task ID from a prior turn — continues a specific task"),
      skill: z.string().optional().describe("Skill hint: pr_review, bug_triage, sitrep, etc."),
      done: z.boolean().optional().describe("Set true on your last message to end the conversation"),
    },
    async ({ agent, message, contextId, taskId, skill, done }) => {
      try {
        const data = await http.post("/api/a2a/chat", { agent, message, contextId, taskId, skill, done });
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const delegateTask = tool(
    "delegate_task",
    "Fire-and-forget: dispatch work to an agent without waiting for results. " +
      "Use for background tasks like 'Quinn, review all open PRs' or 'protoMaker, start auto mode'.",
    {
      agent: z.string().describe("Agent name: quinn, protomaker, protocontent, frank"),
      skill: z.string().describe("Skill to invoke: pr_review, bug_triage, board_health, auto_mode, etc."),
      message: z.string().describe("Task description or instructions"),
      projectSlug: z.string().optional().describe("Project slug for routing"),
    },
    async ({ agent, skill, message, projectSlug }) => {
      try {
        const data = await http.post("/api/a2a/delegate", { agent, skill, message, projectSlug });
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const manageBoard = tool(
    "manage_board",
    "Create or update features on the protoMaker board. Use action 'create' to file " +
      "new work items, 'update' to change status/priority/description of existing features.",
    {
      action: z.enum(["create", "update"]).describe("Operation to perform"),
      projectPath: z.string().describe("Absolute path to the project directory"),
      title: z.string().optional().describe("Feature title (required for create)"),
      description: z.string().optional().describe("Feature description"),
      featureId: z.string().optional().describe("Feature ID (required for update)"),
      status: z.enum(["backlog", "in-progress", "review", "done"]).optional(),
      priority: z.number().optional().describe("0=none, 1=urgent, 2=high, 3=normal, 4=low"),
      complexity: z.enum(["small", "medium", "large", "architectural"]).optional(),
      projectSlug: z.string().optional(),
    },
    async ({ action, projectPath, title, description, featureId, status, priority, complexity, projectSlug }) => {
      try {
        const endpoint = action === "create" ? "/api/board/features/create" : "/api/board/features/update";
        const data = await http.post(endpoint, {
          projectPath, title, description, featureId, status, priority, complexity, projectSlug,
        });
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const createGitHubIssue = tool(
    "create_github_issue",
    "File an issue on a managed GitHub repository. Only repos listed in projects.yaml are allowed.",
    {
      repo: z.string().describe("GitHub repo in owner/name format, e.g. 'protoLabsAI/protoWorkstacean'"),
      title: z.string().describe("Issue title"),
      body: z.string().optional().describe("Issue body (markdown)"),
      labels: z.array(z.string()).optional().describe("Labels to apply"),
    },
    async ({ repo, title, body, labels }) => {
      try {
        const data = await http.post("/api/github/issues", { repo, title, body, labels });
        return ok(data);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const manageCron = tool(
    "manage_cron",
    "Create, update, or delete scheduled ceremonies (cron jobs). " +
      "Ceremonies run agent skills on a schedule. The hot-reload watcher picks up changes within 5 seconds.",
    {
      action: z.enum(["create", "update", "delete", "list"]).describe("CRUD operation"),
      id: z.string().optional().describe("Ceremony ID (required for create/update/delete), e.g. 'board.health'"),
      name: z.string().optional().describe("Human-readable name (required for create)"),
      schedule: z.string().optional().describe("Cron expression, e.g. '*/30 * * * *' (required for create)"),
      skill: z.string().optional().describe("Skill to invoke when ceremony fires (required for create)"),
      targets: z.array(z.string()).optional().describe("Agent targets, e.g. ['quinn'] or ['all']"),
      enabled: z.boolean().optional().describe("Enable or disable the ceremony"),
      notifyChannel: z.string().optional().describe("Discord channel ID for notifications"),
    },
    async ({ action, id, name, schedule, skill, targets, enabled, notifyChannel }) => {
      try {
        if (action === "list") {
          const data = await http.get("/api/ceremonies");
          return ok(data);
        } else if (action === "create") {
          const data = await http.post("/api/ceremonies/create", {
            id, name, schedule, skill, targets, enabled: enabled ?? true, notifyChannel,
          });
          return ok(data);
        } else if (action === "update") {
          const data = await http.post(`/api/ceremonies/${id}/update`, {
            name, schedule, skill, targets, enabled, notifyChannel,
          });
          return ok(data);
        } else {
          const data = await http.post(`/api/ceremonies/${id}/delete`, {});
          return ok(data);
        }
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  const webSearch = tool(
    "web_search",
    "Quick web search via SearXNG. Use for simple factual lookups. " +
      "For deep multi-source research, use chat_with_agent with the researcher agent instead.",
    {
      query: z.string().describe("Search query"),
    },
    async ({ query }) => {
      const searxngUrl = process.env.SEARXNG_URL ?? "http://searxng:8080";
      try {
        const params = new URLSearchParams({ q: query, format: "json", engines: "google,duckduckgo" });
        const resp = await fetch(`${searxngUrl}/search?${params}`, { signal: AbortSignal.timeout(10_000) });
        if (!resp.ok) return err(`SearXNG ${resp.status}`);
        const data = await resp.json() as { results?: Array<{ title: string; content?: string; url?: string }> };
        const results = (data.results ?? []).slice(0, 5);
        if (!results.length) return ok({ results: [], message: "No results found." });
        return ok({ results: results.map(r => ({ title: r.title, snippet: r.content ?? "", url: r.url ?? "" })) });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return [
    publishEvent, getWorldState, getIncidents, reportIncident, getProjects,
    getCiHealth, getPrPipeline, getBranchDrift, getOutcomes, getCeremonies, runCeremony,
    chatWithAgent, delegateTask, manageBoard, createGitHubIssue, manageCron, webSearch,
  ];
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
  "get_projects",
  "get_ci_health",
  "get_pr_pipeline",
  "get_branch_drift",
  "get_outcomes",
  "get_ceremonies",
  "run_ceremony",
  "chat_with_agent",
  "delegate_task",
  "manage_board",
  "create_github_issue",
  "manage_cron",
  "web_search",
  // Discord operations (protoBot agent)
  "discord_server_stats",
  "discord_list_channels",
  "discord_create_channel",
  "discord_send",
  "discord_list_members",
] as const;

export type BusToolName = (typeof BUS_TOOL_NAMES)[number];
