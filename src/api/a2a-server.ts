/**
 * A2A server — exposes workstacean as an A2A-compliant agent.
 *
 * Routes external JSON-RPC calls into the existing bus/executor pipeline:
 *
 *   external agent --(POST /a2a, message/send)--> JsonRpcTransportHandler
 *     --> DefaultRequestHandler --> BusAgentExecutor.execute()
 *       --> bus.publish("agent.skill.request", ...)  [same as internal HTTP API]
 *         --> SkillDispatcherPlugin resolves executor, runs skill
 *           --> bus.publish("agent.skill.response.{correlationId}")
 *             --> BusAgentExecutor translates to Task / Message events
 *               --> ExecutionEventBus --> JsonRpcTransportHandler --> HTTP response
 *
 * The BusAgentExecutor is the adapter — it bridges the A2A task lifecycle
 * to our bus contract. Task state progression:
 *   submitted → working → (optionally input-required → working) → completed/failed
 *
 * Streaming (message/stream) works end-to-end: each status update from the
 * internal executor becomes a TaskStatusUpdateEvent on the A2A stream.
 *
 * Auth: gated by WORKSTACEAN_API_KEY when set. Callers pass it via
 * Authorization: Bearer <key> or X-API-Key. No key set → open access (dev mode).
 */

import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  InMemoryPushNotificationStore,
  DefaultPushNotificationSender,
  JsonRpcTransportHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from "@a2a-js/sdk/server";
import type { Message, Task } from "@a2a-js/sdk";
import type { Route, ApiContext } from "./types.ts";
import type { BusMessage } from "../../lib/types.ts";
import { buildAgentCard } from "./agent-card.ts";

/**
 * Detect when an upstream payload looks like an HTML error page (usually the
 * result of a misrouted HTTP call to a sub-agent whose card URL is wrong —
 * e.g. `<!DOCTYPE html>...Cannot POST /...`). We treat these as failures and
 * sanitize them before they surface as the assistant's reply text.
 *
 * Sentinels cover Express default error body, generic 4xx/5xx HTML, and any
 * payload that's clearly markup rather than a text reply.
 */
function looksLikeHtmlError(text: string): boolean {
  if (!text) return false;
  const head = text.slice(0, 256).toLowerCase();
  return (
    head.startsWith("<!doctype")
    || head.startsWith("<html")
    || head.includes("cannot post /")
    || head.includes("cannot get /")
    || head.includes("404 not found")
  );
}

function sanitizeHtmlError(raw: string): string {
  // Strip tags + `<!DOCTYPE ...>` so the debug hint itself contains no markup
  // — the whole point is that the caller shouldn't see HTML in their reply.
  const hint = raw
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  return (
    "Downstream agent returned an HTTP error (possibly a card misconfiguration). "
    + "See workstacean logs for details. "
    + `[debug hint: ${hint}]`
  );
}

/**
 * Bridges A2A RequestContext → agent.skill.request bus message and back.
 *
 * Skill resolution:
 *   1. params.metadata.skillHint (explicit)
 *   2. Falls through to dispatcher's default executor if skillHint missing
 *
 * The executor emits events in this order:
 *   1. Task (submitted) — initial acknowledgement
 *   2. TaskStatusUpdateEvent (working) — optional, when we see progress
 *   3. TaskStatusUpdateEvent (completed/failed, final=true) — terminal
 *
 * We don't produce partial Message events — all content comes back via the
 * terminal status event's message.parts.
 */
class BusAgentExecutor implements AgentExecutor {
  private readonly activeCancels = new Map<string, () => void>();

  constructor(private readonly ctx: ApiContext) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { userMessage, taskId, contextId } = requestContext;
    const correlationId = taskId;

    // Extract text from the incoming message parts
    const text = (userMessage.parts ?? [])
      .filter((p): p is { kind: "text"; text: string } =>
        "kind" in p && p.kind === "text" && typeof (p as { text?: unknown }).text === "string",
      )
      .map(p => p.text)
      .join("\n");

    // Skill hint — from metadata or fallback to "chat"
    const metadata = (userMessage.metadata ?? {}) as Record<string, unknown>;
    const skill = (typeof metadata.skillHint === "string" && metadata.skillHint)
      || (typeof metadata.skill === "string" && metadata.skill)
      || "chat";
    const explicitTargets = Array.isArray(metadata.targets)
      ? (metadata.targets as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    // This endpoint (ava.proto-labs.ai/a2a) defaults to Ava when no target is
    // specified. The orchestrator agent card aggregates the full fleet's
    // skills, but the routing default must be Ava — she's the helm. Callers
    // route elsewhere by passing explicit `metadata.targets`.
    let targets: string[];
    if (explicitTargets.length === 0) {
      targets = ["ava"];
      console.log("[a2a-server] no target specified, defaulting to [ava] for message/send");
    } else {
      targets = explicitTargets;
    }

    // Emit initial Task event so the caller gets a taskId immediately
    eventBus.publish({
      kind: "task",
      id: taskId,
      contextId,
      status: {
        state: "submitted",
        timestamp: new Date().toISOString(),
      },
      history: [userMessage],
      artifacts: [],
    });

    const replyTopic = `agent.skill.response.${correlationId}`;
    const progressTopic = `agent.skill.progress.${correlationId}`;
    let settled = false;
    let cancelled = false;
    const done = new Promise<void>(resolve => {
      // Progress subscriber — translates intermediate executor-emitted
      // progress events into A2A `status-update` (state=working, final=false).
      // Late events arriving after `settled` are dropped silently. The
      // subscription is torn down on terminal / cancel below to avoid
      // leaking subscriptions across overlapping task ids.
      const progressSubId = this.ctx.bus.subscribe(progressTopic, "a2a-server-progress", (msg: BusMessage) => {
        if (settled) return;
        const p = (msg.payload ?? {}) as {
          text?: string;
          percent?: number;
          step?: string;
          meta?: Record<string, unknown>;
        };
        // Only build a `message` body when the executor supplied `text`.
        // Some emitters may want to push pure-metadata progress (percent /
        // step) for clients that render affordances rather than free text.
        const messageObj = p.text
          ? {
            message: {
              kind: "message" as const,
              messageId: crypto.randomUUID(),
              role: "agent" as const,
              taskId,
              contextId,
              parts: [{ kind: "text" as const, text: p.text }],
            },
          }
          : {};
        const metadataObj =
          p.percent !== undefined || p.step !== undefined || p.meta
            ? {
              metadata: {
                ...(p.percent !== undefined ? { percent: p.percent } : {}),
                ...(p.step !== undefined ? { step: p.step } : {}),
                ...(p.meta ?? {}),
              },
            }
            : {};
        eventBus.publish({
          kind: "status-update",
          taskId,
          contextId,
          status: {
            state: "working",
            timestamp: new Date().toISOString(),
            ...messageObj,
            ...metadataObj,
          },
          final: false,
        });
      });

      const subId = this.ctx.bus.subscribe(replyTopic, "a2a-server", (msg: BusMessage) => {
        if (settled) return;
        settled = true;
        this.ctx.bus.unsubscribe(subId);
        this.ctx.bus.unsubscribe(progressSubId);
        this.activeCancels.delete(taskId);

        const payload = (msg.payload ?? {}) as { content?: string; error?: string };
        const rawError = typeof payload.error === "string" ? payload.error : undefined;
        const rawContent = typeof payload.content === "string" ? payload.content : "";

        // Detect raw HTML error pages bubbling up from a misrouted A2A sub-call
        // (e.g. upstream card URL is wrong — see protoLabsAI/protoMaker#3536).
        // Sanitize them so the caller doesn't see `<!DOCTYPE html>...Cannot
        // POST /...` as the assistant's reply text. Log the raw payload loudly
        // so operators can trace the upstream misconfiguration.
        let errorText = rawError;
        let contentText = rawContent;
        if (rawError && looksLikeHtmlError(rawError)) {
          console.warn(
            `[a2a-server] upstream error payload contained HTML (taskId=${taskId.slice(0, 8)}…); sanitizing. Raw:\n${rawError}`,
          );
          errorText = sanitizeHtmlError(rawError);
        }
        if (!errorText && rawContent && looksLikeHtmlError(rawContent)) {
          console.warn(
            `[a2a-server] upstream content payload contained HTML (taskId=${taskId.slice(0, 8)}…); treating as failure. Raw:\n${rawContent}`,
          );
          errorText = sanitizeHtmlError(rawContent);
          contentText = "";
        }

        const finalState = errorText ? "failed" : "completed";
        const finalText = errorText || contentText || "";

        eventBus.publish({
          kind: "status-update",
          taskId,
          contextId,
          status: {
            state: finalState,
            timestamp: new Date().toISOString(),
            message: {
              kind: "message",
              messageId: crypto.randomUUID(),
              role: "agent",
              taskId,
              contextId,
              parts: [{ kind: "text", text: finalText }],
            },
          },
          final: true,
        });
        eventBus.finished();
        resolve();
      });

      // Cancel hook — TaskStore calls cancelTask() which invokes this to break
      // the await and publish a canceled status.
      this.activeCancels.set(taskId, () => {
        if (settled) return;
        settled = true;
        cancelled = true;
        this.ctx.bus.unsubscribe(subId);
        this.ctx.bus.unsubscribe(progressSubId);
        this.activeCancels.delete(taskId);
        eventBus.publish({
          kind: "status-update",
          taskId,
          contextId,
          status: {
            state: "canceled",
            timestamp: new Date().toISOString(),
          },
          final: true,
        });
        eventBus.finished();
        resolve();
      });
    });

    // Transition to working before dispatching so the caller sees motion.
    eventBus.publish({
      kind: "status-update",
      taskId,
      contextId,
      status: {
        state: "working",
        timestamp: new Date().toISOString(),
      },
      final: false,
    });

    // Dispatch to the bus. SkillDispatcherPlugin handles the rest.
    this.ctx.bus.publish("agent.skill.request", {
      id: crypto.randomUUID(),
      correlationId,
      topic: "agent.skill.request",
      timestamp: Date.now(),
      payload: {
        skill,
        content: text,
        targets,
        // Pass through metadata for downstream consumers
        meta: { ...metadata, via: "a2a-server" },
      },
      reply: { topic: replyTopic },
      source: { interface: "a2a" },
    });

    await done;
    if (cancelled) {
      console.log(`[a2a-server] Task ${taskId.slice(0, 8)}… canceled`);
    }
  }

  async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    const cancel = this.activeCancels.get(taskId);
    if (cancel) cancel();
  }
}

export function createRoutes(ctx: ApiContext): Route[] {
  // Build request handler once per process — it's stateful (task store) but
  // stores are in-memory and all requests go through the same bus pipeline.
  const agentCard = buildAgentCard(ctx);
  const taskStore = new InMemoryTaskStore();
  const pushStore = new InMemoryPushNotificationStore();
  const pushSender = new DefaultPushNotificationSender(pushStore);
  const agentExecutor = new BusAgentExecutor(ctx);
  const requestHandler = new DefaultRequestHandler(
    agentCard,
    taskStore,
    agentExecutor,
    undefined, // default event bus manager
    pushStore,
    pushSender,
  );
  const transport = new JsonRpcTransportHandler(requestHandler);

  const authorize = (req: Request): boolean => {
    if (!ctx.apiKey) return true;
    const apiKeyHeader = req.headers.get("x-api-key");
    if (apiKeyHeader === ctx.apiKey) return true;
    const auth = req.headers.get("authorization") ?? "";
    if (auth === `Bearer ${ctx.apiKey}`) return true;
    return false;
  };

  return [
    {
      method: "POST",
      path: "/a2a",
      handler: async (req) => {
        if (!authorize(req)) {
          return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }

        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return Response.json(
            { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
            { status: 400 },
          );
        }

        try {
          const result = await transport.handle(body);

          // Streaming: result is an AsyncGenerator of JSONRPCResponse. Pipe
          // each frame as a text/event-stream chunk so SSE clients see it.
          if (result && typeof (result as AsyncGenerator).next === "function") {
            const gen = result as AsyncGenerator<unknown, void, undefined>;
            const stream = new ReadableStream({
              async start(controller) {
                const encoder = new TextEncoder();
                try {
                  for await (const event of gen) {
                    const chunk = `data: ${JSON.stringify(event)}\n\n`;
                    controller.enqueue(encoder.encode(chunk));
                  }
                } catch (err) {
                  const errMsg = err instanceof Error ? err.message : String(err);
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: errMsg })}\n\n`));
                } finally {
                  controller.close();
                }
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

          // Non-streaming: single JSON-RPC response
          return Response.json(result as unknown as Record<string, unknown>);
        } catch (err) {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32603,
                message: err instanceof Error ? err.message : "Internal error",
              },
            },
            { status: 500 },
          );
        }
      },
    },
  ];
}

/** Expose the adapter class so tests can drive it directly without HTTP. */
export { BusAgentExecutor };
