/**
 * DeepAgentExecutor — LangGraph ReAct agent for in-process skill execution.
 *
 * Replaces ProtoSdkExecutor. No subprocess spawning, no coding-agent
 * verification prompts. Uses ChatOpenAI pointed at LiteLLM gateway.
 * Tools are standard LangChain tools with zod schemas.
 */

import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage } from "@langchain/core/messages";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { CallbackHandler as LangfuseCallbackHandler } from "@langfuse/langchain";
import { HttpClient } from "../../services/http-client.ts";
import type { AgentDefinition } from "../../agent-runtime/types.ts";
import type { IExecutor, SkillRequest, SkillResult } from "../types.ts";

const LANGFUSE_ENABLED = !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

export interface DeepAgentConfig {
  gatewayUrl?: string;
  gatewayApiKey?: string;
  apiBaseUrl?: string;
  apiKey?: string;
}

/**
 * Cached lean world state summary — refreshed every 60s.
 * Injected into the system prompt so the agent has immediate situational
 * awareness without burning a tool call on get_world_state.
 */
class WorldStateCache {
  private summary = "";
  private lastFetch = 0;
  private fetching = false;
  private readonly ttlMs = 60_000;
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  async getSummary(): Promise<string> {
    if (Date.now() - this.lastFetch < this.ttlMs && this.summary) {
      return this.summary;
    }
    if (this.fetching) return this.summary;
    this.fetching = true;
    try {
      const raw = (await this.http.get("/api/world-state")) as {
        data?: { domains?: Record<string, { data?: unknown }> };
        domains?: Record<string, { data?: unknown }>;
      };
      const domains = raw?.data?.domains ?? raw?.domains ?? {};
      this.summary = WorldStateCache.distill(domains);
      this.lastFetch = Date.now();
    } catch {
      // Keep stale summary on failure
    } finally {
      this.fetching = false;
    }
    return this.summary;
  }

  static distill(domains: Record<string, { data?: unknown }>): string {
    const lines: string[] = ["<world_state_snapshot>"];

    const ci = domains.ci?.data as { successRate?: number; failingMainCount?: number } | undefined;
    if (ci) {
      lines.push(`CI: ${Math.round((ci.successRate ?? 0) * 100)}% success rate, ${ci.failingMainCount ?? 0} repos with failing main`);
    }

    const pr = domains.pr_pipeline?.data as {
      totalOpen?: number; conflicting?: number; readyToMerge?: number;
      failingCi?: number; changesRequested?: number;
    } | undefined;
    if (pr) {
      lines.push(`PRs: ${pr.totalOpen ?? 0} open, ${pr.conflicting ?? 0} conflicts, ${pr.failingCi ?? 0} failing CI, ${pr.readyToMerge ?? 0} ready to merge`);
    }

    const drift = domains.branch_drift?.data as { maxDrift?: number } | undefined;
    if (drift) lines.push(`Branch drift: ${drift.maxDrift ?? 0} commits max`);

    const security = domains.security?.data as { openCount?: number } | undefined;
    if (security) lines.push(`Security: ${security.openCount ?? 0} open incidents`);

    const flow = domains.flow?.data as { efficiency?: { ratio?: number }; distribution?: unknown } | undefined;
    if (flow?.efficiency) lines.push(`Flow efficiency: ${Math.round((flow.efficiency.ratio ?? 0) * 100)}%`);

    const agents = domains.agent_health?.data as { agentCount?: number } | undefined;
    if (agents) lines.push(`Agents: ${agents.agentCount ?? 0} registered`);

    lines.push("</world_state_snapshot>");
    return lines.join("\n");
  }
}

const _worldCaches = new Map<string, WorldStateCache>();

// Each tool() call infers a unique DynamicStructuredTool<ZodObject<{specific fields}>, ...>.
// These are all StructuredToolInterface at runtime, but TS can't unify them into a single
// Record type because tool()'s zod v3/v4 interop overloads produce SchemaOutputT params
// that don't widen back to the base interface defaults. Record stays loose; return is typed.
function createLangChainTools(toolNames: string[], http: HttpClient, correlationId?: string): StructuredToolInterface[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: Record<string, any> = {
    chat_with_agent: tool(
      async (input) => {
        console.log(`[deep-agent:tool] chat_with_agent called: agent=${input.agent}, skill=${input.skill ?? "auto"}, msg="${input.message.slice(0, 80)}"`);
        try {
          const result = await http.post("/api/a2a/chat", input);
          console.log(`[deep-agent:tool] chat_with_agent returned: ${JSON.stringify(result).slice(0, 200)}`);
          return JSON.stringify(result);
        } catch (e) {
          console.error(`[deep-agent:tool] chat_with_agent ERROR:`, e);
          throw e;
        }
      },
      {
        name: "chat_with_agent",
        description:
          "Multi-turn conversation with another agent. " +
          "Pass contextId+taskId from prior response to continue. " +
          "Set done=true on final message. Response includes taskState.",
        schema: z.object({
          agent: z.string(),
          message: z.string(),
          contextId: z.string().optional(),
          taskId: z.string().optional(),
          skill: z.string().optional(),
          done: z.boolean().optional(),
        }),
      },
    ),
    delegate_task: tool(
      async (input) => JSON.stringify(await http.post("/api/a2a/delegate", input)),
      {
        name: "delegate_task",
        description: "Fire-and-forget: dispatch work to an agent.",
        schema: z.object({
          agent: z.string(),
          skill: z.string(),
          message: z.string(),
          projectSlug: z.string().optional(),
        }),
      },
    ),
    get_world_state: tool(
      async () => JSON.stringify(await http.get("/api/world-state")),
      { name: "get_world_state", description: "System health and domain state.", schema: z.object({}) },
    ),
    manage_board: tool(
      async (input) => {
        const ep = input.action === "create" ? "/api/board/features/create" : "/api/board/features/update";
        return JSON.stringify(await http.post(ep, input));
      },
      {
        name: "manage_board",
        description: "Create or update features on the protoMaker board.",
        schema: z.object({
          action: z.enum(["create", "update"]),
          projectPath: z.string(),
          title: z.string().optional(),
          description: z.string().optional(),
          featureId: z.string().optional(),
          status: z.enum(["backlog", "in-progress", "review", "done"]).optional(),
          priority: z.number().optional(),
          complexity: z.enum(["small", "medium", "large", "architectural"]).optional(),
          projectSlug: z.string().optional(),
        }),
      },
    ),
    create_github_issue: tool(
      async (input) => JSON.stringify(await http.post("/api/github/issues", input)),
      {
        name: "create_github_issue",
        description: "File an issue on a managed GitHub repo.",
        schema: z.object({
          repo: z.string(),
          title: z.string(),
          body: z.string().optional(),
          labels: z.array(z.string()).optional(),
        }),
      },
    ),
    manage_cron: tool(
      async (input) => {
        if (input.action === "list") return JSON.stringify(await http.get("/api/ceremonies"));
        if (input.action === "create") return JSON.stringify(await http.post("/api/ceremonies/create", input));
        if (input.action === "update") return JSON.stringify(await http.post(`/api/ceremonies/${input.id}/update`, input));
        if (input.action === "run") return JSON.stringify(await http.post(`/api/ceremonies/${input.id}/run`, {}));
        return JSON.stringify(await http.post(`/api/ceremonies/${input.id}/delete`, {}));
      },
      {
        name: "manage_cron",
        description:
          "CRUD scheduled ceremonies (cron jobs). Actions: list, create, update, delete, run (manual fire — ignores schedule). " +
          "Naming convention: prefix ids with the agent's name (e.g. ava.weekly-rollup) so the dashboard groups by owner. " +
          "Per-agent ownership is enforced server-side via X-API-Key — agent-scoped keys can only update/delete their own ceremonies; admin keys see all.",
        schema: z.object({
          action: z.enum(["create", "update", "delete", "list", "run"]),
          id: z.string().optional(),
          name: z.string().optional(),
          schedule: z.string().optional(),
          skill: z.string().optional(),
          targets: z.array(z.string()).optional(),
          enabled: z.boolean().optional(),
          notifyChannel: z.string().optional(),
        }),
      },
    ),
    get_projects: tool(
      async () => JSON.stringify(await http.get("/api/projects")),
      { name: "get_projects", description: "List all projects.", schema: z.object({}) },
    ),
    get_ci_health: tool(
      async () => JSON.stringify(await http.get("/api/ci-health")),
      { name: "get_ci_health", description: "CI pass rates.", schema: z.object({}) },
    ),
    get_pr_pipeline: tool(
      async () => JSON.stringify(await http.get("/api/pr-pipeline")),
      { name: "get_pr_pipeline", description: "Open PRs and CI status.", schema: z.object({}) },
    ),
    get_branch_drift: tool(
      async () => JSON.stringify(await http.get("/api/branch-drift")),
      { name: "get_branch_drift", description: "Dev vs main divergence.", schema: z.object({}) },
    ),
    get_outcomes: tool(
      async () => JSON.stringify(await http.get("/api/world-state")),
      { name: "get_outcomes", description: "GOAP outcomes and flow.", schema: z.object({}) },
    ),
    get_incidents: tool(
      async () => JSON.stringify(await http.get("/api/incidents")),
      { name: "get_incidents", description: "Open incidents.", schema: z.object({}) },
    ),
    report_incident: tool(
      async (input) => JSON.stringify(await http.post("/api/incidents", input)),
      {
        name: "report_incident",
        description: "File an incident.",
        schema: z.object({ title: z.string(), severity: z.enum(["critical", "high", "medium", "low"]), description: z.string().optional() }),
      },
    ),
    publish_event: tool(
      async (input) => JSON.stringify(await http.post("/publish", input)),
      {
        name: "publish_event",
        description: "Publish a bus event.",
        schema: z.object({ topic: z.string(), payload: z.record(z.unknown()), projectSlug: z.string().optional() }),
      },
    ),
    get_ceremonies: tool(
      async () => JSON.stringify(await http.get("/api/ceremonies")),
      { name: "get_ceremonies", description: "List ceremonies.", schema: z.object({}) },
    ),
    run_ceremony: tool(
      async (input) => JSON.stringify(await http.post(`/api/ceremonies/${input.ceremonyId}/run`, {})),
      { name: "run_ceremony", description: "Trigger a ceremony.", schema: z.object({ ceremonyId: z.string() }) },
    ),
    web_search: tool(
      async (input) => {
        const searxngUrl = process.env.SEARXNG_URL ?? "http://searxng:8080";
        const params = new URLSearchParams({ q: input.query, format: "json", engines: "google,duckduckgo" });
        const resp = await fetch(`${searxngUrl}/search?${params}`, { signal: AbortSignal.timeout(10_000) });
        const data = await resp.json() as { results?: Array<{ title: string; content?: string; url?: string }> };
        const results = (data.results ?? []).slice(0, 5);
        return JSON.stringify(results.map(r => ({ title: r.title, snippet: r.content ?? "", url: r.url ?? "" })));
      },
      {
        name: "web_search",
        description: "Quick web search via SearXNG. For deep research, use chat_with_agent with the researcher agent.",
        schema: z.object({ query: z.string().describe("Search query") }),
      },
    ),
    // ── Discord operations (protoBot agent) ──────────────────────────────────
    discord_server_stats: tool(
      async () => JSON.stringify(await http.get("/api/discord/server-stats")),
      { name: "discord_server_stats", description: "Discord server stats: members, channels, roles, boost level.", schema: z.object({}) },
    ),
    discord_list_channels: tool(
      async () => JSON.stringify(await http.get("/api/discord/channels")),
      { name: "discord_list_channels", description: "List all Discord channels with type and category.", schema: z.object({}) },
    ),
    discord_create_channel: tool(
      async (input) => JSON.stringify(await http.post("/api/discord/channels/create", input)),
      {
        name: "discord_create_channel",
        description: "Create a Discord channel. Types: text, voice, category, announcement, forum.",
        schema: z.object({
          name: z.string().describe("Channel name (lowercase, hyphens)"),
          type: z.enum(["text", "voice", "category", "announcement", "forum"]).optional().describe("Channel type (default: text)"),
          parent: z.string().optional().describe("Parent category name or ID"),
          topic: z.string().optional().describe("Channel topic/description"),
        }),
      },
    ),
    discord_delete_channel: tool(
      async (input) => JSON.stringify(await http.post("/api/discord/channels/delete", input)),
      {
        name: "discord_delete_channel",
        description:
          "Delete a Discord channel by ID or name. For categories, by default all child channels are deleted too (set recursive=false to leave them as orphans). Destructive — confirm with the user before invoking unless the user explicitly named the channel/category to delete.",
        schema: z.object({
          channelId: z.string().optional().describe("Channel ID (exact)"),
          channelName: z.string().optional().describe("Channel name (alternative to ID)"),
          recursive: z.boolean().optional().describe("For categories: delete contained channels too (default: true)"),
          reason: z.string().optional().describe("Audit log reason"),
        }),
      },
    ),
    discord_send: tool(
      async (input) => JSON.stringify(await http.post("/api/discord/send", input)),
      {
        name: "discord_send",
        description: "Send a message to a Discord channel by name or ID.",
        schema: z.object({
          content: z.string().describe("Message content (markdown supported, max 2000 chars)"),
          channelId: z.string().optional().describe("Channel ID"),
          channelName: z.string().optional().describe("Channel name (alternative to ID)"),
        }),
      },
    ),
    discord_list_members: tool(
      async () => JSON.stringify(await http.get("/api/discord/members")),
      { name: "discord_list_members", description: "List Discord server members with roles.", schema: z.object({}) },
    ),
    discord_list_webhooks: tool(
      async () => JSON.stringify(await http.get("/api/discord/webhooks")),
      { name: "discord_list_webhooks", description: "List all Discord webhooks across guild channels.", schema: z.object({}) },
    ),
    discord_create_webhook: tool(
      async (input) => JSON.stringify(await http.post("/api/discord/webhooks/create", input)),
      {
        name: "discord_create_webhook",
        description: "Create a Discord webhook on a channel for external integrations (GitHub, CI, etc.).",
        schema: z.object({
          name: z.string().describe("Webhook display name"),
          channelId: z.string().optional().describe("Target channel ID"),
          channelName: z.string().optional().describe("Target channel name (alternative to ID)"),
          reason: z.string().optional().describe("Audit log reason"),
        }),
      },
    ),
    // ── Conversation feedback tools (require correlationId) ──────────────────
    react: tool(
      async (input) => {
        if (!correlationId) return JSON.stringify({ success: false, error: "No active conversation" });
        return JSON.stringify(await http.post("/api/discord/react", { correlationId, emoji: input.emoji }));
      },
      {
        name: "react",
        description:
          "Add an emoji reaction to the user's triggering message. Use for acknowledgment before a long task " +
          "(eyes for 'working on it', hourglass for 'slow one', thinking for 'considering'). " +
          "Don't react on every response — only when you're about to do substantial work.",
        schema: z.object({
          emoji: z.string().describe("Single emoji to react with (e.g. 👀, ⏳, 🤔, ✅, 🔍)"),
        }),
      },
    ),
    send_update: tool(
      async (input) => {
        if (!correlationId) return JSON.stringify({ success: false, error: "No active conversation" });
        return JSON.stringify(await http.post("/api/discord/progress", { correlationId, content: input.content }));
      },
      {
        name: "send_update",
        description:
          "Send a brief progress update to the user while other tools run. Throttled server-side to 1 per 5s — " +
          "don't spam, use only for meaningful progress (e.g. 'Quinn is reviewing the PR now', 'Searching the board...'). " +
          "The user WILL see the final response — this is just for long-running work.",
        schema: z.object({
          content: z.string().describe("Short progress message (max 2000 chars, ideally 1 sentence)"),
        }),
      },
    ),
  };

  return toolNames.map(n => all[n]).filter(Boolean) as StructuredToolInterface[];
}

export class DeepAgentExecutor implements IExecutor {
  readonly type = "deep-agent";
  private readonly agentDef: AgentDefinition;
  private readonly model: ChatOpenAI;
  private readonly http: HttpClient;

  private readonly worldCache: WorldStateCache;

  constructor(agentDef: AgentDefinition, config: DeepAgentConfig = {}) {
    this.agentDef = agentDef;
    const gatewayUrl = config.gatewayUrl ?? process.env.LLM_GATEWAY_URL ?? process.env.OPENAI_BASE_URL;
    const apiKey = config.gatewayApiKey ?? process.env.OPENAI_API_KEY ?? "unused";

    this.model = new ChatOpenAI({
      model: agentDef.model,
      temperature: 0,
      configuration: gatewayUrl ? { baseURL: gatewayUrl } : undefined,
      apiKey,
    });

    this.http = new HttpClient({
      baseUrl: config.apiBaseUrl ?? "http://localhost:3000",
      timeoutMs: 120_000, // 2 min — chat_with_agent calls A2A which can take time
      ...(config.apiKey ? { auth: { type: "api-key" as const, key: config.apiKey } } : {}),
    });

    // Shared cache keyed by API base URL — all agents hitting the same
    // workstacean instance share one cache + refresh cycle.
    const cacheKey = config.apiBaseUrl ?? "http://localhost:3000";
    if (!_worldCaches.has(cacheKey)) {
      _worldCaches.set(cacheKey, new WorldStateCache(this.http));
    }
    this.worldCache = _worldCaches.get(cacheKey)!;
  }

  async execute(req: SkillRequest): Promise<SkillResult> {
    const prompt = req.content ?? req.prompt ?? this._buildPrompt(req);
    const tools = createLangChainTools(this.agentDef.tools, this.http, req.correlationId);

    const callbacks = LANGFUSE_ENABLED
      ? [new LangfuseCallbackHandler({
          sessionId: req.correlationId,
          userId: this.agentDef.name,
          traceMetadata: { skill: req.skill, agent: this.agentDef.name },
        })]
      : [];

    try {
      // Inject cached world state into system prompt for instant situational awareness
      const worldSummary = await this.worldCache.getSummary();
      const enrichedPrompt = worldSummary
        ? `${this.agentDef.systemPrompt}\n\n## Current system state (auto-refreshed, do not repeat verbatim)\n\n${worldSummary}`
        : this.agentDef.systemPrompt;

      const agent = createReactAgent({
        llm: this.model,
        tools,
        messageModifier: new SystemMessage(enrichedPrompt),
      });

      console.log(`[deep-agent:${this.agentDef.name}] invoke with ${tools.length} tools, prompt length=${prompt.length}, langfuse=${LANGFUSE_ENABLED}`);

      const result = await agent.invoke(
        { messages: [{ role: "user", content: prompt }] },
        { recursionLimit: this.agentDef.maxTurns * 2 + 1, callbacks },
      );

      const messages = result.messages ?? [];
      console.log(`[deep-agent:${this.agentDef.name}] ${messages.length} messages returned`);

      // Log tool calls made
      for (const msg of messages) {
        const type = msg._getType?.() ?? msg.constructor?.name ?? "";
        if (type === "ai" || type === "AIMessage") {
          const tc = (msg as unknown as Record<string, unknown>).tool_calls;
          if (Array.isArray(tc) && tc.length > 0) {
            console.log(`[deep-agent:${this.agentDef.name}] tool calls: ${tc.map((t: { name?: string }) => t.name).join(", ")}`);
          }
        }
      }

      let text = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const content = msg.content;
        if (typeof content === "string" && content.trim()) {
          const type = msg._getType?.() ?? msg.constructor?.name ?? "";
          if (type === "ai" || type === "AIMessage") {
            text = content.trim();
            break;
          }
        }
      }

      return {
        text: text || "No response generated.",
        isError: false,
        correlationId: req.correlationId,
      };
    } catch (e) {
      console.error(`[deep-agent:${this.agentDef.name}]`, e);
      return {
        text: e instanceof Error ? e.message : String(e),
        isError: true,
        correlationId: req.correlationId,
      };
    }
  }

  private _buildPrompt(req: SkillRequest): string {
    const lines = [`Execute skill: ${req.skill}`];
    const ctx = Object.entries(req.payload)
      .filter(([k]) => !["skill", "replyTopic", "correlationId", "parentId"].includes(k))
      .map(([k, v]) => {
        if (typeof v !== "object") return `${k}: ${String(v)}`;
        try { return `${k}: ${JSON.stringify(v)}`; } catch { return `${k}: [unserializable]`; }
      });
    if (ctx.length > 0) lines.push("", "Context:", ...ctx);
    return lines.join("\n");
  }
}
