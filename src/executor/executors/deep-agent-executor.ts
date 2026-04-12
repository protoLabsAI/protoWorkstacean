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
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { HttpClient } from "../../services/http-client.ts";
import type { AgentDefinition } from "../../agent-runtime/types.ts";
import type { IExecutor, SkillRequest, SkillResult } from "../types.ts";

export interface DeepAgentConfig {
  gatewayUrl?: string;
  gatewayApiKey?: string;
  apiBaseUrl?: string;
  apiKey?: string;
}

function createLangChainTools(toolNames: string[], http: HttpClient) {
  const all: Record<string, ReturnType<typeof tool>> = {
    chat_with_agent: tool(
      async (input) => JSON.stringify(await http.post("/api/a2a/chat", input)),
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
        return JSON.stringify(await http.post(`/api/ceremonies/${input.id}/delete`, {}));
      },
      {
        name: "manage_cron",
        description: "CRUD scheduled ceremonies.",
        schema: z.object({
          action: z.enum(["create", "update", "delete", "list"]),
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
  };

  return toolNames.map(n => all[n]).filter((t): t is ReturnType<typeof tool> => t != null);
}

export class DeepAgentExecutor implements IExecutor {
  readonly type = "deep-agent";
  private readonly agentDef: AgentDefinition;
  private readonly model: ChatOpenAI;
  private readonly http: HttpClient;

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
      ...(config.apiKey ? { auth: { type: "api-key" as const, key: config.apiKey } } : {}),
    });
  }

  async execute(req: SkillRequest): Promise<SkillResult> {
    const prompt = req.content ?? req.prompt ?? this._buildPrompt(req);
    const tools = createLangChainTools(this.agentDef.tools, this.http);

    try {
      const agent = createReactAgent({
        llm: this.model,
        tools,
        messageModifier: new SystemMessage(this.agentDef.systemPrompt),
      });

      const result = await agent.invoke(
        { messages: [{ role: "user", content: prompt }] },
        { recursionLimit: this.agentDef.maxTurns * 2 + 1 },
      );

      const messages = result.messages ?? [];
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
