/**
 * OpenAI-compatible API — exposes the fleet via the de-facto chat-completions
 * protocol so any OpenAI-speaking client (Cursor, Zed, aider, `llm` CLI,
 * ChatGPT desktop proxies, LiteLLM routers, etc.) can dispatch to any skill.
 *
 * Endpoints:
 *   GET  /v1/models               — list skills from the agent card as models
 *   POST /v1/chat/completions     — dispatch (streaming + non-streaming)
 *
 * Model-to-skill mapping (the `model` field in the request body):
 *   - "chat"              → skill=chat, targets=[]  (workstacean default-routes)
 *   - "ava"               → skill=chat, targets=["ava"]   (agent-only alias)
 *   - "quinn/pr_review"   → skill=pr_review, targets=["quinn"]  (explicit)
 *   - "<skill>"           → skill=<skill>, targets=[]  (broker routes by skill)
 *
 * Dispatch path reuses the same bus → SkillDispatcherPlugin → executor flow
 * as the A2A server and /api/a2a/chat. Responses translate back to the
 * ChatCompletion / ChatCompletionChunk shape OpenAI clients expect.
 *
 * Streaming: SSE frames `data: {chunk}\n\n` with a final `data: [DONE]`.
 * Text arrives as a single delta today (executor emits the final text once);
 * future integration with streaming artifact chunks (Phase 5 of the A2A
 * refactor) can split text deltas per chunk without changing the contract.
 */

import type { Route, ApiContext } from "./types.ts";
import type { BusMessage } from "../../lib/types.ts";
import { buildAgentCard } from "./agent-card.ts";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  user?: string;
}

interface SkillRouting {
  skill: string;
  targets: string[];
}

/**
 * Parse the `model` field into a skill + optional target-agent list.
 * Accepts:
 *   - "skill"           → { skill, targets: [] }
 *   - "agent/skill"     → { skill, targets: [agent] }
 *   - "ava" (special)   → { skill: "chat", targets: ["ava"] }
 */
function modelToRouting(model: string): SkillRouting {
  if (!model) return { skill: "chat", targets: [] };
  if (model === "ava") return { skill: "chat", targets: ["ava"] };
  const slash = model.indexOf("/");
  if (slash > 0) {
    return {
      skill: model.slice(slash + 1),
      targets: [model.slice(0, slash)],
    };
  }
  return { skill: model, targets: [] };
}

/**
 * Compose a prompt from the messages array. Collapses system + prior turns
 * into a single text blob with role prefixes; the last user message is the
 * "current" content. This mirrors what a non-multi-turn executor expects.
 */
function flattenMessages(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    const content = typeof m.content === "string" ? m.content : "";
    if (!content) continue;
    if (m.role === "system") parts.push(`[system] ${content}`);
    else if (m.role === "user") parts.push(`[user] ${content}`);
    else if (m.role === "assistant") parts.push(`[assistant] ${content}`);
  }
  return parts.join("\n\n");
}

export function createRoutes(ctx: ApiContext): Route[] {
  function requireAuth(req: Request): Response | null {
    if (!ctx.apiKey) return null;
    const headerKey = req.headers.get("X-API-Key");
    const bearer = req.headers.get("Authorization");
    const apiKey = headerKey ?? (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null);
    if (apiKey === ctx.apiKey) return null;
    if (ctx.agentKeys && ctx.agentKeys.resolve(apiKey)) return null;
    return Response.json({ error: { message: "Unauthorized", type: "auth_error" } }, { status: 401 });
  }

  /**
   * GET /v1/models — advertise every fleet skill as a model.
   *
   * Emits both the bare skill ID ("pr_review") and the agent/skill form
   * ("quinn/pr_review") so callers can pick either by default-routing or
   * by explicit targeting.
   */
  function handleListModels(req: Request): Response {
    const authErr = requireAuth(req);
    if (authErr) return authErr;

    const card = buildAgentCard(ctx);
    const created = Math.floor(Date.now() / 1000);
    const seen = new Set<string>();
    const models: Array<Record<string, unknown>> = [];

    for (const skill of card.skills ?? []) {
      const id = String(skill.id ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, object: "model", created, owned_by: "protolabs-fleet" });

      // Also expose agent/skill aliases from the tags
      const agentTag = (skill.tags ?? []).find(t => t !== "routed");
      if (agentTag) {
        const aliased = `${agentTag}/${id}`;
        if (!seen.has(aliased)) {
          seen.add(aliased);
          models.push({ id: aliased, object: "model", created, owned_by: "protolabs-fleet" });
        }
      }
    }

    // Top-level "ava" alias (chat skill targeted at ava)
    if (!seen.has("ava")) {
      models.push({ id: "ava", object: "model", created, owned_by: "protolabs-fleet" });
    }

    return Response.json({ object: "list", data: models });
  }

  /**
   * Dispatch a chat-completion request onto the bus and await the response
   * on the reply topic. Resolves to the final text or throws on error.
   */
  async function dispatchChat(routing: SkillRouting, prompt: string): Promise<{ text: string; error?: string }> {
    const correlationId = crypto.randomUUID();
    const replyTopic = `agent.skill.response.${correlationId}`;

    return new Promise((resolve) => {
      let settled = false;
      const timeoutMs = 10 * 60_000;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ctx.bus.unsubscribe(subId);
        resolve({ text: "", error: `timeout waiting for ${routing.skill} reply` });
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();

      const subId = ctx.bus.subscribe(replyTopic, "openai-compat", (msg: BusMessage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.bus.unsubscribe(subId);

        const payload = (msg.payload ?? {}) as { content?: string; error?: string };
        if (payload.error) {
          resolve({ text: "", error: payload.error });
        } else {
          resolve({ text: payload.content ?? "" });
        }
      });

      ctx.bus.publish("agent.skill.request", {
        id: crypto.randomUUID(),
        correlationId,
        topic: "agent.skill.request",
        timestamp: Date.now(),
        payload: {
          skill: routing.skill,
          content: prompt,
          targets: routing.targets,
          meta: { via: "openai-compat" },
        },
        reply: { topic: replyTopic },
        source: { interface: "openai-compat" },
      });
    });
  }

  /**
   * POST /v1/chat/completions — the meat.
   *
   * Non-streaming: returns a ChatCompletion object with a single choice.
   * Streaming: returns text/event-stream with one delta chunk + a stop chunk
   *           + terminator `data: [DONE]`.
   */
  async function handleChatCompletions(req: Request): Promise<Response> {
    const authErr = requireAuth(req);
    if (authErr) return authErr;

    let body: ChatCompletionRequest;
    try {
      body = (await req.json()) as ChatCompletionRequest;
    } catch {
      return Response.json({ error: { message: "Invalid JSON", type: "invalid_request_error" } }, { status: 400 });
    }

    if (!body.model || typeof body.model !== "string") {
      return Response.json({ error: { message: "model is required", type: "invalid_request_error" } }, { status: 400 });
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return Response.json({ error: { message: "messages is required and must be non-empty", type: "invalid_request_error" } }, { status: 400 });
    }

    const routing = modelToRouting(body.model);
    const prompt = flattenMessages(body.messages);
    const id = `chatcmpl-${crypto.randomUUID().slice(0, 16)}`;
    const created = Math.floor(Date.now() / 1000);
    const wantStream = body.stream === true;

    if (!wantStream) {
      const { text, error } = await dispatchChat(routing, prompt);
      if (error) {
        return Response.json({
          error: { message: error, type: "server_error" },
        }, { status: 502 });
      }
      return Response.json({
        id,
        object: "chat.completion",
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }

    // Streaming — SSE with ChatCompletionChunk frames
    const stream = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (obj: Record<string, unknown>) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

        // Role chunk — OpenAI clients often look for role in the first delta
        send({
          id, object: "chat.completion.chunk", created, model: body.model,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        });

        const { text, error } = await dispatchChat(routing, prompt);
        if (error) {
          send({
            id, object: "chat.completion.chunk", created, model: body.model,
            choices: [{ index: 0, delta: { content: `[error] ${error}` }, finish_reason: "stop" }],
          });
        } else {
          // Single content delta — future work: split into chunks when the
          // executor emits streaming artifact text events.
          send({
            id, object: "chat.completion.chunk", created, model: body.model,
            choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
          });
          send({
            id, object: "chat.completion.chunk", created, model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          });
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  return [
    { method: "GET",  path: "/v1/models",           handler: req => handleListModels(req) },
    { method: "POST", path: "/v1/chat/completions", handler: req => handleChatCompletions(req) },
  ];
}

/** Exposed for tests — deterministic mapping, pure function. */
export { modelToRouting, flattenMessages };
