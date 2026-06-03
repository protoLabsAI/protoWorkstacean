/**
 * DeepAgentExecutor — LangGraph ReAct agent for in-process skill execution.
 *
 * Replaces ProtoSdkExecutor. No subprocess spawning, no coding-agent
 * verification prompts. Uses ChatOpenAI pointed at LiteLLM gateway.
 * Tools are standard LangChain tools with zod schemas.
 */

import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatOpenAI } from "@langchain/openai";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { CallbackHandler as LangfuseCallbackHandler } from "@langfuse/langchain";
import { HttpClient } from "../../services/http-client.ts";
import type { AgentDefinition } from "../../agent-runtime/types.ts";
import type { IExecutor, SkillRequest, SkillResult } from "../types.ts";
import { runStructuredFinalizer, type ForcedToolCaller } from "./structured-finalizer.ts";
import { AgentMemory, memoryAppliesTo } from "../../knowledge/agent-memory.ts";

const LANGFUSE_ENABLED = !!(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);

/** Sleep used by chat_with_agent's pending-result poller. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** chat_with_agent polls a pending A2A result this often, up to this budget,
 *  before handing back the pending marker. Slow skills (recon, pentest) finish
 *  well inside this; it just bounds the wait so a stuck task can't pin the tool.
 *  Interval is env-overridable (DEEP_AGENT_CHAT_POLL_INTERVAL_MS). */
const CHAT_POLL_BUDGET_MS = 240_000;
function chatPollIntervalMs(): number {
  return Number(process.env.DEEP_AGENT_CHAT_POLL_INTERVAL_MS) || 5_000;
}

/**
 * Extract the assistant's text output from a LangChain AIMessage's `content`.
 * Reasoning-style models (e.g. protolabs/reasoning, o3, claude with extended
 * thinking) emit `content` as an array of typed blocks rather than a string:
 *   [{type: "thinking", thinking: "..."}, {type: "text", text: "..."}]
 * The text we want is the concatenation of `text`-typed blocks. Returns the
 * trimmed result, or "" if no usable text was found.
 */
/**
 * Resolve which tools a skill invocation gets. When a skill declares its own
 * `tools` list we intersect with the agent's declared tools — a skill cannot
 * grant access to tools the agent never advertised. When the skill omits
 * tools we fall back to the agent's full list. Pure function, easy to unit-
 * test; the runtime branch in `execute()` is a thin wrapper around this.
 */
export function effectiveToolsFor(skillTools: string[] | undefined, agentTools: string[]): string[] {
  if (!skillTools) return agentTools;
  return skillTools.filter(t => agentTools.includes(t));
}

/** Skill's maxTurns wins when set; else inherit from the agent. */
export function effectiveMaxTurnsFor(skillMaxTurns: number | undefined, agentMaxTurns: number): number {
  return skillMaxTurns ?? agentMaxTurns;
}

/**
 * Per-call model override wins when set + non-empty; else falls back to the
 * agent's declared model. Whitespace-only overrides are treated as unset
 * (covers the case where a Linear/Discord payload carries an accidental
 * blank string through routing). Pure function — exported for unit testing.
 */
export function effectiveModelFor(payloadModel: unknown, agentModel: string): string {
  if (typeof payloadModel === "string" && payloadModel.trim().length > 0) {
    return payloadModel.trim();
  }
  return agentModel;
}

export function extractAiText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
  }
  return parts.join("").trim();
}

/** A tool-call turn worth narrating — the names + their parsed calls. */
export interface ToolCallNarration {
  toolNames: string[];
  toolCalls: Array<{ name: string; args?: unknown }>;
}

/**
 * Scan `messages[fromIndex..]` for AI messages carrying `tool_calls` and return
 * one narration per such message, in order. Drives live progress narration as
 * the graph streams: the caller advances `fromIndex` past everything already
 * seen, so each tool-call turn is narrated exactly once — no double-fire when
 * the same accumulated state is re-yielded, no miss when several arrive in one
 * step. Messages without tool calls (human, tool results, the final answer)
 * yield nothing.
 */
export function extractToolCallNarrations(messages: unknown[], fromIndex: number): ToolCallNarration[] {
  const out: ToolCallNarration[] = [];
  for (let i = Math.max(0, fromIndex); i < messages.length; i++) {
    const msg = messages[i] as { _getType?: () => string; constructor?: { name?: string }; tool_calls?: unknown };
    const type = msg?._getType?.() ?? msg?.constructor?.name ?? "";
    if (type !== "ai" && type !== "AIMessage") continue;
    const tc = msg?.tool_calls;
    if (!Array.isArray(tc) || tc.length === 0) continue;
    const toolCalls = tc
      .map((t: { name?: string; args?: unknown }) => ({ name: t.name ?? "", args: t.args }))
      .filter((c) => c.name);
    if (toolCalls.length === 0) continue;
    out.push({ toolNames: toolCalls.map((c) => c.name), toolCalls });
  }
  return out;
}

export interface DeepAgentConfig {
  gatewayUrl?: string;
  gatewayApiKey?: string;
  apiBaseUrl?: string;
  apiKey?: string;
  /**
   * Best-effort telemetry hook fired for each tool-call turn made during
   * a skill invocation. Wired by `AgentRuntimePlugin` to publish on
   * `agent.runtime.activity.tool.call` so the /system dashboard can show
   * live per-tool-call detail inside each agent's node. Errors thrown
   * inside the callback are swallowed — telemetry never breaks a skill.
   *
   * Skill-level lifecycle (start / complete / error) is emitted by the
   * SkillDispatcher across ALL executor types and does not need this hook.
   */
  onToolCall?: (event: { agentName: string; correlationId: string; skill?: string; toolNames: string[]; toolCalls?: Array<{ name: string; args?: unknown }> }) => void;

  /**
   * Best-effort generic progress hook fired for non-tool-call milestones
   * during a skill run — currently the initial "thinking" frame emitted the
   * moment the graph starts, before the first LLM turn produces any tool call.
   * Wired by `AgentRuntimePlugin` to publish `agent.skill.progress.{cid}` so
   * A2A callers see motion during the initial model-latency window instead of
   * a byte-silent run. Errors inside the callback are swallowed.
   */
  onProgress?: (event: { agentName: string; correlationId: string; skill?: string; text: string; step?: string }) => void;

  /**
   * Shared memory flywheel. When provided AND the agent declares `memory`,
   * conversational skills replay recent turns + recalled knowledge into each
   * invocation and persist the turn afterward. One instance backs all agents.
   */
  memory?: AgentMemory;
}

// Each tool() call infers a unique DynamicStructuredTool<ZodObject<{specific fields}>, ...>.
// These are all StructuredToolInterface at runtime, but TS can't unify them into a single
// Record type because tool()'s zod v3/v4 interop overloads produce SchemaOutputT params
// that don't widen back to the base interface defaults. Record stays loose; return is typed.
export function createLangChainTools(toolNames: string[], http: HttpClient, correlationId?: string, agentName?: string): StructuredToolInterface[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const all: Record<string, any> = {
    chat_with_agent: tool(
      async (input) => {
        console.log(`[deep-agent:tool] chat_with_agent called: agent=${input.agent}, skill=${input.skill ?? "auto"}, msg="${input.message.slice(0, 80)}"`);
        try {
          const body = agentName ? { ...input, dispatcherAgent: agentName } : input;
          const result = await http.post("/api/a2a/chat", body) as { success?: boolean; data?: Record<string, unknown> };

          // Slow A2A skills return { pending: true, pollUrl } after the chat
          // endpoint's wait window. Poll it to completion so chat_with_agent
          // presents a synchronous result instead of leaking the pending stub.
          const data = result?.data;
          if (data?.pending === true && typeof data.pollUrl === "string") {
            const deadline = Date.now() + CHAT_POLL_BUDGET_MS;
            while (Date.now() < deadline) {
              await sleep(chatPollIntervalMs());
              const polled = await http.get(data.pollUrl) as { data?: Record<string, unknown> };
              const pd = polled?.data;
              if (!pd) continue;
              if (pd.done === true) {
                const merged = {
                  success: !pd.error,
                  data: {
                    response: pd.response ?? null,
                    taskState: pd.taskState,
                    correlationId: pd.correlationId,
                    agent: input.agent,
                    ...(pd.taskId ? { taskId: pd.taskId } : {}),
                    ...(pd.contextId ? { contextId: pd.contextId } : {}),
                    ...(pd.error ? { error: pd.error } : {}),
                    ...(pd.usage ? { usage: pd.usage } : {}),
                    ...(pd.costUsd !== undefined ? { costUsd: pd.costUsd } : {}),
                    ...(pd.confidence !== undefined ? { confidence: pd.confidence } : {}),
                  },
                };
                console.log(`[deep-agent:tool] chat_with_agent resolved pending ${input.agent} task: taskState=${pd.taskState}`);
                return JSON.stringify(merged);
              }
              if (pd.taskState === "unknown") break; // never tracked / aged out
            }
            console.log(`[deep-agent:tool] chat_with_agent ${input.agent} still pending after budget`);
            return JSON.stringify(result);
          }

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
          "Multi-turn conversation with another agent. Reaches ANY registered agent — " +
          "call list_agents to see the live fleet. Pass contextId+taskId from a prior " +
          "response to continue; set done=true on your final message. Long-running skills " +
          "are polled to completion automatically, so the response carries the agent's real " +
          "output plus taskState.",
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
      async (input) => {
        const body = agentName ? { ...input, dispatcherAgent: agentName } : input;
        return JSON.stringify(await http.post("/api/a2a/delegate", body));
      },
      {
        name: "delegate_task",
        description:
          "Fire-and-forget: dispatch work to an agent without waiting. Reaches ANY " +
          "registered agent (see list_agents). Returns a correlationId + pollUrl.",
        schema: z.object({
          agent: z.string(),
          skill: z.string(),
          message: z.string(),
          projectSlug: z.string().optional(),
        }),
      },
    ),
    list_agents: tool(
      async () => {
        const res = await http.get("/api/agents/runtime") as {
          data?: { agents?: Array<{ name: string; type: string; skills: string[]; pendingDiscovery?: boolean }> };
        };
        // Exclude self and the synthetic function-executor cluster (alert.*,
        // ceremony.*, pr.* — plugin infra, not a conversational delegate target).
        const agents = (res?.data?.agents ?? []).filter((a) => a.name !== agentName && a.type !== "function");
        return JSON.stringify({ success: true, agents });
      },
      {
        name: "list_agents",
        description:
          "List the live agent fleet you can reach via chat_with_agent / delegate_task — " +
          "each registered agent with its type (deep-agent | a2a) and the skills it serves. " +
          "This registry is the source of truth; call it to discover who's available rather " +
          "than assuming a fixed roster. Agents with pendingDiscovery=true are configured but " +
          "not currently reachable (e.g. an A2A host that's offline).",
        schema: z.object({}),
      },
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
    clawpatch_review: tool(
      async (input) => JSON.stringify(await http.post("/api/clawpatch/review", input)),
      {
        name: "clawpatch_review",
        description:
          "Run structural code review via clawpatch. Maps the repo into semantic feature slices, reviews each, and returns structured findings (correctness bugs, security issues, race/concurrency, data-loss, resource leaks, bad error handling, API contract mismatches, missing tests, build hazards, maintainability risks). Use DURING pr_review to fold findings into the QA Audit body's Observations section with severity + file:line cites.\n\n" +
          "**Provider choice:**\n" +
          "- `gateway` (default) — stateless LLM call to the LiteLLM endpoint. Prompt has file contents pre-inlined. Fast, cheap, good for nearly every PR.\n" +
          "- `proto` — spawns protoCLI as a live ACP agent during review. Agent has tool access: read additional files, run LSP queries, run typecheck/lint. Slower + more tokens but deeper structural read. Use on non-trivial PRs that warrant active investigation (large diffs, suspicious test coverage, novel patterns).\n\n" +
          "Today v1 only works for repos already mounted in the container (protoWorkstacean, protoCLI, mythxengine); other repos return a clear error. The `since` arg scopes the review to features touched since that git ref — pass the PR base.",
        schema: z.object({
          repo: z.string().describe("Repository in owner/name format (e.g. protoLabsAI/protoWorkstacean)."),
          since: z.string().optional().describe("Git ref (branch or SHA) to diff against. Limits the review to features touched since that ref. Use the PR base (typically 'main' or 'dev')."),
          limit: z.number().int().optional().describe("Maximum number of features to review. Useful for spot-checks on large repos."),
          model: z.string().optional().describe("Model override. Defaults vary per provider (gateway: protolabs/smart; proto: protolabs/reasoning)."),
          provider: z.enum(["gateway", "proto"]).optional().describe("Review path. 'gateway' (default) for fast stateless LLM review; 'proto' for live tool-using ACP agent review on non-trivial changes."),
        }),
      },
    ),
    pr_inspector: tool(
      async (input) => JSON.stringify(await http.post("/api/pr/inspect", input)),
      {
        name: "pr_inspector",
        description:
          "Inspect AND act on GitHub PRs. The `repo` arg (owner/name) is REQUIRED on every call. Actions:\n" +
          "- list_open: list open PRs in a repo\n" +
          "- check_ci: CI check states for a PR\n" +
          "- coderabbit_threads: unresolved review threads on a PR\n" +
          "- diff_summary: first 200 lines of the PR diff\n" +
          "- review_comment: post a COMMENTED review (requires body)\n" +
          "- review_approve: post an APPROVED review (body optional)\n" +
          "- review_request_changes: post a CHANGES_REQUESTED review (requires body)\n" +
          "- close_pr: close a PR (optionally with a leading comment explaining why)\n" +
          "- close_pr_as_not_planned: close + mark state_reason=not_planned (use when the PR is stale, superseded, or the underlying request was resolved differently)\n" +
          "- reopen_pr: reopen a closed (non-merged) PR\n\n" +
          "Prefer closing a stale/resolved PR directly to filing a 'please close #X' issue — that's the cascade pattern from #556. Always include `comment` on close_pr / close_pr_as_not_planned so the close has audit context.",
        schema: z.object({
          action: z.enum([
            "list_open",
            "check_ci",
            "coderabbit_threads",
            "diff_summary",
            "review_comment",
            "review_approve",
            "review_request_changes",
            "close_pr",
            "close_pr_as_not_planned",
            "reopen_pr",
          ]),
          repo: z.string().describe(
            "Repository in owner/name format (e.g. protoLabsAI/protoWorkstacean). REQUIRED on every call.",
          ),
          pr_number: z.number().int().optional(),
          body: z.string().optional().describe("Review body for review_* actions."),
          comment: z.string().optional().describe("Optional leading comment posted before close_pr / close_pr_as_not_planned. Recommended for audit trail."),
        }),
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
    searxng_search: tool(
      async (input) => {
        const endpoint = process.env.SEARXNG_URL ?? "http://searxng:8080";
        const url = new URL("/search", endpoint);
        url.searchParams.set("q", input.query);
        url.searchParams.set("format", "json");
        if (input.category) url.searchParams.set("categories", input.category);
        if (input.time_range) url.searchParams.set("time_range", input.time_range);
        const resp = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        });
        const data = await resp.json() as {
          results?: Array<{ title: string; url: string; content: string; engine: string; score?: number }>;
          answers?: string[];
          suggestions?: string[];
          infoboxes?: Array<{ infobox: string; content: string }>;
        };
        const cap = input.max_results ?? 10;
        return JSON.stringify({
          results: (data.results ?? []).slice(0, cap).map(r => ({ title: r.title, url: r.url, snippet: r.content, engine: r.engine })),
          ...(data.answers?.length ? { answers: data.answers } : {}),
          ...(data.suggestions?.length ? { suggestions: data.suggestions } : {}),
          ...(data.infoboxes?.length ? { infoboxes: data.infoboxes.map(ib => ({ title: ib.infobox, content: ib.content })) } : {}),
        });
      },
      {
        name: "searxng_search",
        description: "Search via SearXNG with category routing (general, news, science, it). Supports bang syntax (!wp, !scholar, !gh). For deep research, use chat_with_agent with the researcher agent.",
        schema: z.object({
          query: z.string().describe("Search query. Supports SearXNG bang syntax."),
          category: z.enum(["general", "news", "science", "it"]).optional().describe("SearXNG category."),
          time_range: z.enum(["day", "week", "month", "year"]).optional().describe("Limit to time range."),
          max_results: z.number().optional().describe("Max results. Default: 10."),
        }),
      },
    ),
    // ── Research: knowledge base + source connectors (researcher agent) ───────
    research_search: tool(
      async (input) => JSON.stringify(await http.post("/api/research/search", input)),
      {
        name: "research_search",
        description: "Hybrid (semantic + keyword) search over the research knowledge base — prior papers, findings, digests, and model releases. Use this BEFORE external searches to reuse what's already been gathered.",
        schema: z.object({
          query: z.string().describe("What to look for."),
          k: z.number().optional().describe("Max results (default 5)."),
          kind: z.enum(["paper", "finding", "digest", "model_release"]).optional().describe("Restrict to one kind."),
        }),
      },
    ),
    research_ingest: tool(
      async (input) => JSON.stringify(await http.post("/api/research/ingest", input)),
      {
        name: "research_ingest",
        description: "Store a research item (paper, finding, digest, or model_release) into the searchable knowledge base so it's recallable in future research.",
        schema: z.object({
          kind: z.enum(["paper", "finding", "digest", "model_release"]).describe("What this item is."),
          content: z.string().describe("The substance — abstract, finding text, digest body, or model summary."),
          title: z.string().optional(),
          source: z.string().optional().describe("Where it came from (e.g. arxiv, huggingface, github, discord)."),
          url: z.string().optional(),
          metadata: z.record(z.unknown()).optional(),
        }),
      },
    ),
    research_stats: tool(
      async () => JSON.stringify(await http.get("/api/research/stats")),
      { name: "research_stats", description: "Counts of stored research items per kind.", schema: z.object({}) },
    ),
    huggingface_search: tool(
      async (input) => {
        const type = input.type ?? "models";
        const params = new URLSearchParams({ search: input.query, limit: String(input.limit ?? 10), full: "false" });
        if (input.sort) params.set("sort", input.sort);
        try {
          const res = await fetch(`https://huggingface.co/api/${type}?${params}`, { headers: { Accept: "application/json" } });
          if (!res.ok) return JSON.stringify({ error: `HuggingFace ${res.status}` });
          const data = (await res.json()) as Array<Record<string, unknown>>;
          return JSON.stringify({ results: data.slice(0, input.limit ?? 10).map(d => ({ id: d.id ?? d.modelId, downloads: d.downloads, likes: d.likes, pipeline_tag: d.pipeline_tag, updated: d.lastModified })) });
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
      {
        name: "huggingface_search",
        description: "Search HuggingFace Hub for models or datasets (trending / by downloads / likes). Public — no auth.",
        schema: z.object({
          query: z.string().describe("Search terms."),
          type: z.enum(["models", "datasets"]).optional().describe("Default: models."),
          sort: z.enum(["downloads", "likes", "lastModified"]).optional().describe("Sort order."),
          limit: z.number().optional().describe("Max results (default 10)."),
        }),
      },
    ),
    github_trending: tool(
      async (input) => {
        const q = [input.query, input.language ? `language:${input.language}` : ""].filter(Boolean).join(" ");
        const params = new URLSearchParams({ q: q || "stars:>1000", sort: input.sort ?? "stars", order: "desc", per_page: String(input.limit ?? 10) });
        const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
        if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
        try {
          const res = await fetch(`https://api.github.com/search/repositories?${params}`, { headers });
          if (!res.ok) return JSON.stringify({ error: `GitHub ${res.status}` });
          const data = (await res.json()) as { items?: Array<Record<string, unknown>> };
          return JSON.stringify({ results: (data.items ?? []).slice(0, input.limit ?? 10).map(r => ({ full_name: r.full_name, stars: r.stargazers_count, description: r.description, url: r.html_url, language: r.language, pushed_at: r.pushed_at })) });
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
      {
        name: "github_trending",
        description: "Search GitHub repositories by topic/language sorted by stars or recent activity — find trending AI/ML projects and releases.",
        schema: z.object({
          query: z.string().describe("Search terms (e.g. 'llm inference', 'diffusion')."),
          language: z.string().optional().describe("Restrict to a language (e.g. python, rust)."),
          sort: z.enum(["stars", "updated"]).optional().describe("Default: stars."),
          limit: z.number().optional().describe("Max results (default 10)."),
        }),
      },
    ),
    discord_scan_feed: tool(
      async (input) => {
        const token = process.env.DISCORD_BOT_TOKEN;
        if (!token) return JSON.stringify({ error: "DISCORD_BOT_TOKEN not set" });
        try {
          const res = await fetch(`https://discord.com/api/v10/channels/${input.channelId}/messages?limit=${input.limit ?? 30}`, {
            headers: { Authorization: `Bot ${token}` },
          });
          if (!res.ok) return JSON.stringify({ error: `Discord ${res.status}` });
          const msgs = (await res.json()) as Array<{ content?: string; embeds?: Array<{ url?: string; title?: string }>; author?: { username?: string } }>;
          const urlRe = /https?:\/\/[^\s<>")]+/g;
          const classify = (u: string): string =>
            /arxiv\.org/.test(u) ? "arxiv" : /huggingface\.co/.test(u) ? "huggingface" : /github\.com/.test(u) ? "github" : /(youtube|youtu\.be)/.test(u) ? "video" : "web";
          const links: Array<{ url: string; type: string; from?: string }> = [];
          for (const m of msgs) {
            for (const u of (m.content ?? "").match(urlRe) ?? []) links.push({ url: u, type: classify(u), from: m.author?.username });
            for (const e of m.embeds ?? []) if (e.url) links.push({ url: e.url, type: classify(e.url), from: m.author?.username });
          }
          return JSON.stringify({ scanned: msgs.length, links: links.slice(0, 50) });
        } catch (e) { return JSON.stringify({ error: e instanceof Error ? e.message : String(e) }); }
      },
      {
        name: "discord_scan_feed",
        description: "Scan a Discord channel's recent messages and extract + classify shared links (arxiv, huggingface, github, video, web) — the team's research feed.",
        schema: z.object({
          channelId: z.string().describe("Discord channel ID to scan."),
          limit: z.number().optional().describe("Messages to scan (default 30, max 100)."),
        }),
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
    // ── Google Workspace (pull-mode reader/drafter — no auto-send) ───────────
    gmail_list_unread: tool(
      async (input) => {
        const url = new URL("/api/google/gmail/list-unread", "http://x");
        if (input.label) url.searchParams.set("label", input.label);
        if (input.max) url.searchParams.set("max", String(input.max));
        return JSON.stringify(await http.get(url.pathname + url.search));
      },
      {
        name: "gmail_list_unread",
        description: "List unread Gmail messages in a label (default INBOX). Use when the operator asks 'what's in my inbox?'.",
        schema: z.object({
          label: z.string().optional().describe("Gmail label (default INBOX)"),
          max: z.number().optional().describe("Max results (default 20, max 100)"),
        }),
      },
    ),
    gmail_search: tool(
      async (input) => {
        const url = new URL("/api/google/gmail/search", "http://x");
        url.searchParams.set("q", input.query);
        if (input.max) url.searchParams.set("max", String(input.max));
        return JSON.stringify(await http.get(url.pathname + url.search));
      },
      {
        name: "gmail_search",
        description: "Search Gmail with native Gmail query syntax (from:, subject:, after:, has:attachment, etc.).",
        schema: z.object({
          query: z.string().describe("Gmail search query"),
          max: z.number().optional().describe("Max results (default 20, max 100)"),
        }),
      },
    ),
    gmail_get_thread: tool(
      async (input) => JSON.stringify(await http.get(`/api/google/gmail/thread/${encodeURIComponent(input.threadId)}`)),
      {
        name: "gmail_get_thread",
        description: "Read the full message history of a Gmail thread. Returns headers and bodies for every message.",
        schema: z.object({ threadId: z.string() }),
      },
    ),
    gmail_create_draft: tool(
      async (input) => JSON.stringify(await http.post("/api/google/gmail/draft", input)),
      {
        name: "gmail_create_draft",
        description:
          "Create a Gmail DRAFT reply. The draft lands in the operator's Drafts folder for manual review and send — nothing is sent automatically. " +
          "If threadId is provided, To/Subject/In-Reply-To are auto-resolved from the thread.",
        schema: z.object({
          threadId: z.string().optional().describe("Thread to reply to. Auto-resolves To/Subject/In-Reply-To."),
          body: z.string().describe("Plain-text body of the draft"),
          to: z.string().optional().describe("Recipient (required when threadId is omitted)"),
          subject: z.string().optional().describe("Subject (required when threadId is omitted)"),
          inReplyTo: z.string().optional(),
          references: z.string().optional(),
        }),
      },
    ),
    calendar_list_upcoming: tool(
      async (input) => {
        const url = new URL("/api/google/calendar/upcoming", "http://x");
        if (input.days) url.searchParams.set("days", String(input.days));
        if (input.calendarId) url.searchParams.set("calendarId", input.calendarId);
        return JSON.stringify(await http.get(url.pathname + url.search));
      },
      {
        name: "calendar_list_upcoming",
        description: "List upcoming calendar events for the next N days (default 7) on the primary calendar.",
        schema: z.object({
          days: z.number().optional().describe("Window in days (default 7, max 90)"),
          calendarId: z.string().optional().describe("Calendar ID (default 'primary')"),
        }),
      },
    ),
    calendar_event_detail: tool(
      async (input) => {
        const url = new URL(`/api/google/calendar/event/${encodeURIComponent(input.eventId)}`, "http://x");
        if (input.calendarId) url.searchParams.set("calendarId", input.calendarId);
        return JSON.stringify(await http.get(url.pathname + url.search));
      },
      {
        name: "calendar_event_detail",
        description: "Fetch full detail (description, attendees, RSVPs) for a single calendar event.",
        schema: z.object({
          eventId: z.string(),
          calendarId: z.string().optional().describe("Calendar ID (default 'primary')"),
        }),
      },
    ),
    // ── Linear (board read + filing write) ───────────────────────────────────
    linear_list_teams: tool(
      async () => JSON.stringify(await http.get("/api/linear/teams")),
      { name: "linear_list_teams", description: "List all Linear teams (id, key, name).", schema: z.object({}) },
    ),
    linear_list_issues: tool(
      async (input) => {
        const url = new URL("/api/linear/issues", "http://x");
        if (input.team) url.searchParams.set("team", input.team);
        if (input.state) url.searchParams.set("state", input.state);
        if (input.label) url.searchParams.set("label", input.label);
        if (input.assignee) url.searchParams.set("assignee", input.assignee);
        if (input.max) url.searchParams.set("max", String(input.max));
        return JSON.stringify(await http.get(url.pathname + url.search));
      },
      {
        name: "linear_list_issues",
        description: "List Linear issues with optional filters. Use to answer 'how many open issues?' or 'what's in the ENG backlog?'.",
        schema: z.object({
          team: z.string().optional().describe("Team key (e.g. ENG)"),
          state: z.string().optional().describe("Workflow state name (e.g. 'In Progress', 'Backlog')"),
          label: z.string().optional().describe("Label name"),
          assignee: z.string().optional().describe("Set 'me' to filter to issues assigned to the API key holder"),
          max: z.number().optional().describe("Max results (default 50, max 250)"),
        }),
      },
    ),
    linear_search_issues: tool(
      async (input) => {
        const url = new URL("/api/linear/issues/search", "http://x");
        url.searchParams.set("q", input.query);
        if (input.max) url.searchParams.set("max", String(input.max));
        return JSON.stringify(await http.get(url.pathname + url.search));
      },
      {
        name: "linear_search_issues",
        description: "Full-text search across Linear issues.",
        schema: z.object({
          query: z.string(),
          max: z.number().optional().describe("Max results (default 25, max 100)"),
        }),
      },
    ),
    linear_get_issue: tool(
      async (input) => JSON.stringify(await http.get(`/api/linear/issues/${encodeURIComponent(input.idOrKey)}`)),
      {
        name: "linear_get_issue",
        description: "Read one Linear issue with full description, labels, and comment history. Accepts UUID or identifier (e.g. 'ENG-123').",
        schema: z.object({ idOrKey: z.string() }),
      },
    ),
    linear_create_issue: tool(
      async (input) => JSON.stringify(await http.post("/api/linear/issues", input)),
      {
        name: "linear_create_issue",
        description: "File a new Linear issue. Use when the operator asks to create one explicitly.",
        schema: z.object({
          teamKey: z.string().describe("Team key (e.g. ENG)"),
          title: z.string(),
          description: z.string().optional(),
          priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
          labelIds: z.array(z.string()).optional(),
          stateName: z.string().optional().describe("Workflow state name (default: team's default backlog)"),
        }),
      },
    ),
    linear_add_comment: tool(
      async (input) => JSON.stringify(await http.post(`/api/linear/issues/${encodeURIComponent(input.issueId)}/comment`, { body: input.body })),
      {
        name: "linear_add_comment",
        description: "Post a comment to a Linear issue.",
        schema: z.object({
          issueId: z.string().describe("Issue UUID (use linear_get_issue to resolve identifier → UUID first if needed)"),
          body: z.string(),
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
    ask_human: tool(
      async (input) => {
        if (!correlationId) {
          return JSON.stringify({ success: false, error: "No active conversation — ask_human only works while responding to a caller." });
        }
        // Blocks until the caller answers (POST /api/a2a/input) or the wait
        // window elapses. Give the HTTP call slightly more than the server's
        // wait window so the endpoint returns first.
        const res = (await http.post(
          "/api/agent/ask-human",
          { correlationId, question: input.question },
          { timeoutMs: 120_000 },
        )) as { success?: boolean; answer?: string | null; timedOut?: boolean };
        if (res.timedOut) {
          return JSON.stringify({ success: false, timedOut: true, note: "The caller did not answer within the wait window." });
        }
        return JSON.stringify({ success: true, answer: res.answer });
      },
      {
        name: "ask_human",
        description:
          "Ask the caller who invoked you a question and WAIT for their answer. Use when you genuinely need their " +
          "input or a decision to proceed — a missing detail, an approval, or a choice between options. Returns the " +
          "caller's answer as a string. They see an input-required prompt and typically answer within seconds. Use " +
          "sparingly: only when you cannot proceed without it, not for things you can reasonably decide yourself.",
        schema: z.object({
          question: z.string().describe("The question to ask the caller. Be specific and self-contained."),
        }),
      },
    ),
    msg_operator: tool(
      async (input) =>
        JSON.stringify(await http.post("/api/operator/message", {
          message: input.message,
          urgency: input.urgency ?? "normal",
          ...(input.topic ? { topic: input.topic } : {}),
          from: agentName ?? "agent",
        })),
      {
        name: "msg_operator",
        description:
          "Send a direct message to the human operator (a Discord DM). Use for genuine escalation only — a dead end " +
          "after you've exhausted your options, a decision that needs credentials / infrastructure / policy, or " +
          "cost/risk beyond your authority. Not for routine progress (that's send_update). Match urgency to reality: " +
          "low (FYI), normal (needs attention this session), high (review soon), urgent (system degraded, act now).",
        schema: z.object({
          message: z.string().describe("What the operator needs to know — specific and self-contained, including what you already tried."),
          urgency: z.enum(["low", "normal", "high", "urgent"]).optional().describe("Defaults to normal."),
          topic: z.string().optional().describe("Optional short subject tag."),
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
  private readonly onToolCall: DeepAgentConfig["onToolCall"];
  private readonly onProgress: DeepAgentConfig["onProgress"];
  private readonly gatewayUrl: string | undefined;
  private readonly apiKey: string;
  private readonly memory: AgentMemory | undefined;
  /**
   * Cache of ChatOpenAI instances by model name — `agentDef.model` always
   * resolves to `this.model`, but per-call overrides (`payload.model`) get
   * a lazily-built clone keyed by the override string. Stops us from
   * paying construction cost on every dispatch that overrides.
   */
  private readonly modelCache: Map<string, ChatOpenAI> = new Map();

  constructor(agentDef: AgentDefinition, config: DeepAgentConfig = {}) {
    this.agentDef = agentDef;
    this.onToolCall = config.onToolCall;
    this.onProgress = config.onProgress;
    this.gatewayUrl = config.gatewayUrl ?? process.env.LLM_GATEWAY_URL ?? process.env.OPENAI_BASE_URL;
    this.apiKey = config.gatewayApiKey ?? process.env.OPENAI_API_KEY ?? "unused";
    this.memory = config.memory;

    this.model = this._buildModel(agentDef.model);
    this.modelCache.set(agentDef.model, this.model);

    this.http = new HttpClient({
      baseUrl: config.apiBaseUrl ?? "http://localhost:3000",
      timeoutMs: 120_000, // 2 min — chat_with_agent calls A2A which can take time
      ...(config.apiKey ? { auth: { type: "api-key" as const, key: config.apiKey } } : {}),
    });
  }

  private _buildModel(modelName: string): ChatOpenAI {
    return new ChatOpenAI({
      model: modelName,
      temperature: 0,
      configuration: this.gatewayUrl ? { baseURL: this.gatewayUrl } : undefined,
      apiKey: this.apiKey,
    });
  }

  /**
   * Resolve which ChatOpenAI to use for this dispatch. Defaults to the
   * agent's declared model; per-call override via `payload.model` builds
   * (and caches) a clone with the new model name. All other ChatOpenAI
   * config (gateway URL, api key, temperature) stays identical.
   */
  private _modelFor(override: string | undefined): ChatOpenAI {
    if (!override || override === this.agentDef.model) return this.model;
    const cached = this.modelCache.get(override);
    if (cached) return cached;
    const built = this._buildModel(override);
    this.modelCache.set(override, built);
    return built;
  }

  /**
   * Release idle resources when this executor is unregistered (ADR-0004
   * hot-swap). Drops the per-model ChatOpenAI cache so the instances can be
   * GC'd. Safe with an in-flight `execute()` — that call already holds its own
   * model + agent references, so clearing the cache never touches running work.
   */
  dispose(): void {
    this.modelCache.clear();
  }

  async execute(req: SkillRequest): Promise<SkillResult> {
    const prompt = req.content ?? req.prompt ?? this._buildPrompt(req);

    const skillDef = req.skill
      ? this.agentDef.skills.find(s => s.name === req.skill)
      : undefined;

    // Memory flywheel — only when the agent opts in AND this is a conversational
    // skill. The conversation key is contextId (multi-turn chat) falling back to
    // correlationId (a one-off, which simply has no prior history).
    const memoryOn = !!this.memory && memoryAppliesTo(this.agentDef.memory, req.skill);
    const memCfg = this.agentDef.memory;
    const memCtxId = req.contextId ?? req.correlationId;

    // Skill-level tools override: intersect with agent.tools (a skill can't
    // grant access to tools the agent doesn't declare). When skill.tools is
    // unset, all of agent.tools are available. This is the structural way
    // to keep narrow skills (pr_review) from fanning out into delegation /
    // web search and exhausting the recursion limit.
    const agentTools = this.agentDef.tools;
    const effectiveTools = effectiveToolsFor(skillDef?.tools, agentTools);
    const tools = createLangChainTools(effectiveTools, this.http, req.correlationId, this.agentDef.name);

    const effectiveMaxTurns = effectiveMaxTurnsFor(skillDef?.maxTurns, this.agentDef.maxTurns);

    const callbacks = LANGFUSE_ENABLED
      ? [new LangfuseCallbackHandler({
          sessionId: req.correlationId,
          userId: this.agentDef.name,
          traceMetadata: { skill: req.skill, agent: this.agentDef.name },
        })]
      : [];

    try {
      // Resolve skill-level systemPromptOverride if this skill defines one.
      // Skills like diagnose_pr_stuck have narrow, structured output requirements
      // that replace the agent's general-purpose prompt.
      let basePrompt = skillDef?.systemPromptOverride ?? this.agentDef.systemPrompt;

      // Cross-conversation recall (Phase 2): inject hot memory + BM25 hits for
      // this turn's prompt into the system message.
      if (memoryOn) {
        const recall = this.memory!.recallBlock(prompt, memCfg);
        if (recall) basePrompt += `\n\n## Recalled context\n${recall}`;
      }

      // Per-call model override via payload.model — see effectiveModelFor
      // + the matching path in ProtoSdkExecutor. Lets a caller escalate to
      // Opus (or downshift to Haiku) for one dispatch without editing the
      // agent yaml.
      const resolvedModel = effectiveModelFor(req.payload?.model, this.agentDef.model);
      const modelOverride = resolvedModel !== this.agentDef.model ? resolvedModel : undefined;
      const llm = this._modelFor(modelOverride);

      const agent = createReactAgent({
        llm,
        tools,
        messageModifier: new SystemMessage(basePrompt),
      });

      const usingModel = modelOverride && modelOverride !== this.agentDef.model
        ? ` (model override: ${modelOverride})`
        : "";
      console.log(`[deep-agent:${this.agentDef.name}] invoke skill="${req.skill ?? "?"}" tools=${tools.length}/${agentTools.length} maxTurns=${effectiveMaxTurns} promptLen=${prompt.length} langfuse=${LANGFUSE_ENABLED}${usingModel}`);

      // Within-conversation history (Phase 1): replay recent turns so the agent
      // sees the conversation, not just the latest message.
      const history = memoryOn ? this.memory!.history(memCtxId, memCfg) : [];

      // Ephemeral surrounding context (Phase 4): a trigger surface (e.g. Discord
      // reply-chain / scrollback / thread / attachments) can attach a
      // `contextPreamble`. Inject it into THIS turn's user message only — it is
      // never persisted as conversation history (memory.record stores `prompt`).
      const preamble = typeof req.payload?.contextPreamble === "string" ? req.payload.contextPreamble : "";
      const userContent = preamble ? `${preamble}\n\n${prompt}` : prompt;

      // Emit an immediate "thinking" frame so A2A callers see motion during the
      // initial model-latency window (the first LLM turn can take 15–20s before
      // it produces any tool call). Without this the stream is byte-silent —
      // only empty keepalive heartbeats — until the first tool call lands.
      if (this.onProgress) {
        try {
          this.onProgress({ agentName: this.agentDef.name, correlationId: req.correlationId, skill: req.skill, text: "thinking", step: "thinking" });
        } catch (cbErr) {
          console.warn(`[deep-agent:${this.agentDef.name}] onProgress callback threw:`, cbErr);
        }
      }

      // Stream the graph rather than invoke()-ing it, so tool-call narration
      // reaches the caller LIVE (the moment each turn streams in) instead of
      // being replayed in a tight loop after the whole run settles — which made
      // every progress frame arrive ~1ms before the terminal answer (#778
      // wired the bridge but the source fired post-hoc). streamMode "values"
      // yields the full accumulated state after each node; the final yield is
      // exactly what invoke() would have returned, so all downstream extraction
      // (final text, memory, structured output) is unchanged.
      type RunMessage = { _getType?: () => string; constructor?: { name?: string }; content?: unknown; tool_calls?: unknown };
      let result: { messages?: RunMessage[] } = { messages: [] };
      let narrated = 0;
      for await (const state of await agent.stream(
        { messages: [...history.map(t => ({ role: t.role, content: t.content })), { role: "user", content: userContent }] },
        { recursionLimit: effectiveMaxTurns * 2 + 1, callbacks, streamMode: "values" },
      )) {
        result = state as unknown as { messages?: RunMessage[] };
        const msgs = result.messages ?? [];
        // Narrate any tool-call turn that streamed in this step and hasn't been
        // narrated yet — live, before its tools execute.
        for (const n of extractToolCallNarrations(msgs, narrated)) {
          console.log(`[deep-agent:${this.agentDef.name}] tool calls: ${n.toolNames.join(", ")}`);
          if (this.onToolCall) {
            try {
              this.onToolCall({ agentName: this.agentDef.name, correlationId: req.correlationId, skill: req.skill, toolNames: n.toolNames, toolCalls: n.toolCalls });
            } catch (cbErr) {
              // Telemetry must never break a running skill.
              console.warn(`[deep-agent:${this.agentDef.name}] onToolCall callback threw:`, cbErr);
            }
          }
        }
        narrated = msgs.length;
      }

      const messages = result.messages ?? [];
      console.log(`[deep-agent:${this.agentDef.name}] ${messages.length} messages returned`);

      let text = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        const type = msg._getType?.() ?? msg.constructor?.name ?? "";
        if (type !== "ai" && type !== "AIMessage") continue;
        const extracted = extractAiText(msg.content);
        if (extracted) {
          text = extracted;
          break;
        }
      }

      const finalText = text || "No response generated.";

      // Persist the turn + extract a finding (Phases 1+2). Best-effort; the
      // store never throws into the caller.
      if (memoryOn) {
        this.memory!.record(memCtxId, {
          agent: this.agentDef.name,
          skill: req.skill,
          userText: prompt,
          aiText: finalText,
        });
      }

      // Structured finalizer: when the skill declares an outputSchema, distill
      // the analysis into a schema-shaped object via a forced submit_<skill>
      // tool call (NOT response_format — the reasoning backend ignores that).
      // No schema ⇒ unchanged free-text behavior.
      if (skillDef?.outputSchema && skillDef.resultMime && req.skill) {
        const finalized = await runStructuredFinalizer(
          req.skill,
          skillDef.outputSchema,
          finalText,
          this._forcedToolCaller(llm),
        );
        console.log(
          `[deep-agent:${this.agentDef.name}] structured finalizer for "${req.skill}" → ${skillDef.resultMime}${finalized.repaired ? " (repaired)" : ""}`,
        );
        return {
          text: JSON.stringify(finalized.value),
          isError: false,
          correlationId: req.correlationId,
          data: { resultData: finalized.value, resultMime: skillDef.resultMime },
        };
      }

      return {
        text: finalText,
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

  /**
   * Build a `ForcedToolCaller` over a ChatOpenAI instance. This is the seam
   * for tool_choice forcing through the LangGraph/LiteLLM gateway: the prebuilt
   * ReAct agent does not expose tool_choice, so the finalizer is a *direct*
   * `bindTools(..., { tool_choice })` call. We bind a single OpenAI-style
   * function tool whose `parameters` ARE the skill's JSON Schema and pin
   * `tool_choice` to it, then read the parsed args off the response's
   * `tool_calls[0].args`.
   */
  private _forcedToolCaller(llm: ChatOpenAI): ForcedToolCaller {
    return async ({ system, user, toolName, parameters }) => {
      const bound = llm.bindTools(
        [{ type: "function", function: { name: toolName, parameters: parameters as Record<string, unknown> } }],
        { tool_choice: { type: "function", function: { name: toolName } } },
      );
      const response = await bound.invoke([new SystemMessage(system), new HumanMessage(user)]);
      const toolCalls = (response as unknown as { tool_calls?: Array<{ name?: string; args?: unknown }> }).tool_calls;
      const call = toolCalls?.find((t) => t.name === toolName) ?? toolCalls?.[0];
      if (!call) {
        throw new Error(`forced tool "${toolName}" produced no tool call`);
      }
      return call.args;
    };
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
