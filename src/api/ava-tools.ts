/**
 * Ava operational tools — chat with agent (multi-turn A2A) + delegate task.
 *
 * These endpoints back Ava's chat_with_agent and delegate_task bus tools.
 * BOTH go through the bus (agent.skill.request → SkillDispatcher → executor),
 * the same path every other trigger uses. chat awaits the real terminal result
 * on the reply topic (agent.skill.response.{correlationId}) with a timeout;
 * TaskTracker drives long-running A2A tasks to a terminal state and publishes
 * the actual artifact there. No executor is called directly — so the chokepoint
 * invariants (cooldown, target guard, …) and task lifecycle apply uniformly,
 * and chat returns the agent's genuine output rather than a submit-ack.
 */

import type { Route, ApiContext } from "./types.ts";
import type { EventBus } from "../../lib/types.ts";
import type { AgentSkillResponsePayload } from "../event-bus/payloads.ts";

const AGENT_OPS_CHANNEL = process.env.DISCORD_AGENT_OPS_CHANNEL ?? "";

/** How long a synchronous chat blocks for the terminal result before returning
 *  `pending`. Passive skills finish well within this; long-running ones (e.g.
 *  active pentests) return pending + a pollUrl. Override with
 *  A2A_CHAT_REPLY_TIMEOUT_MS. */
const REPLY_TIMEOUT_MS = 30_000;

function replyTimeoutMs(): number {
  return Number(process.env.A2A_CHAT_REPLY_TIMEOUT_MS) || REPLY_TIMEOUT_MS;
}

/**
 * Subscribe to a skill request's reply topic and resolve with the response
 * payload when it arrives, or `null` on timeout. Subscribes immediately so the
 * caller can publish the request right after and not miss a fast completion.
 */
function awaitSkillResponse(
  bus: EventBus,
  correlationId: string,
  timeoutMs: number,
): Promise<AgentSkillResponsePayload | null> {
  return new Promise((resolve) => {
    let settled = false;
    let subId = "";
    const timer = setTimeout(() => finish(null), timeoutMs);
    function finish(val: AgentSkillResponsePayload | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (subId) bus.unsubscribe(subId);
      resolve(val);
    }
    subId = bus.subscribe(
      `agent.skill.response.${correlationId}`,
      "a2a-chat-await",
      (msg) => finish((msg.payload ?? null) as AgentSkillResponsePayload | null),
    );
  });
}

export function createRoutes(ctx: ApiContext): Route[] {
  /**
   * POST /api/a2a/chat — multi-turn conversation with an agent over the bus.
   *
   * Body: { agent, message, contextId?, skill?, done?, dispatcherAgent?,
   *   returnImmediately? }
   * Returns on completion: { success, data: { response, contextId?, taskId?,
   *   taskState, correlationId, agent, usage?, costUsd?, confidence?, durationMs? } }
   * Returns on timeout OR returnImmediately:true: { success, data: { pending: true,
   *   response: null, taskState, correlationId, contextId?, agent, pollUrl } }
   *
   * returnImmediately:true (A2A SendMessageConfiguration) dispatches and returns
   * the poll handle right away instead of blocking up to the reply timeout —
   * use it for slow skills (deep_research) so a synchronous caller never wedges.
   *
   * When done=true, the response omits contextId/taskId to signal conversation end.
   */
  async function handleChat(req: Request): Promise<Response> {
    if (ctx.apiKey && req.headers.get("X-API-Key") !== ctx.apiKey) {
      return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });
    }

    const agent = body.agent as string | undefined;
    const message = body.message as string | undefined;
    const contextId = body.contextId as string | undefined;
    const skill = (body.skill as string) || "chat";
    const done = body.done === true;
    const dispatcherAgent = typeof body.dispatcherAgent === "string" ? body.dispatcherAgent : undefined;
    // A2A SendMessageConfiguration.returnImmediately: hand back a poll handle
    // now instead of blocking up to the reply timeout. For slow skills
    // (deep_research, research_digest) this stops a synchronous caller from
    // wedging on the 30s timeout — they poll the task endpoint for the result.
    const returnImmediately = body.returnImmediately === true;

    if (!agent || !message) {
      return Response.json(
        { success: false, error: "agent and message are required" },
        { status: 400 },
      );
    }

    // Fast guard: no executor for this agent → 404 without dispatching.
    if (!ctx.executorRegistry.resolve(skill, [agent])) {
      return Response.json(
        { success: false, error: `No executor found for agent "${agent}"` },
        { status: 404 },
      );
    }

    const correlationId = crypto.randomUUID();
    const conversationId = contextId ?? crypto.randomUUID();

    // Ava's outbound message for o11y (agent-ops channel + Discord mirror).
    ctx.bus.publish("agent.chat.outbound", {
      id: crypto.randomUUID(),
      correlationId,
      topic: "agent.chat.outbound",
      timestamp: Date.now(),
      payload: { from: "ava", to: agent, contextId: conversationId, message, skill },
    });
    if (AGENT_OPS_CHANNEL) {
      ctx.bus.publish(`message.outbound.discord.push.${AGENT_OPS_CHANNEL}`, {
        id: crypto.randomUUID(),
        correlationId,
        topic: `message.outbound.discord.push.${AGENT_OPS_CHANNEL}`,
        timestamp: Date.now(),
        payload: {
          content: `**ava → ${agent}** (${skill})\n${message.length > 300 ? message.slice(0, 300) + "…" : message}`,
        },
      });
    }

    // Listen for the terminal result BEFORE dispatching so a fast inline
    // completion can't fire before we're subscribed. Skipped when the caller
    // opted into an immediate poll-handle response (nothing to await).
    const replyPromise = returnImmediately
      ? undefined
      : awaitSkillResponse(ctx.bus, correlationId, replyTimeoutMs());

    ctx.bus.publish("agent.skill.request", {
      id: crypto.randomUUID(),
      correlationId,
      topic: "agent.skill.request",
      timestamp: Date.now(),
      payload: {
        skill,
        content: message,
        targets: [agent],
        contextId: conversationId,
        ...(dispatcherAgent ? { meta: { dispatcherAgent } } : {}),
      },
    });

    // Dispatched — hand back the poll handle now. The result lands on the same
    // poll endpoint (GET /api/a2a/task/{correlationId}) when the task finishes.
    if (returnImmediately) {
      return Response.json({
        success: true,
        data: {
          pending: true,
          response: null,
          taskState: "submitted",
          correlationId,
          ...(done ? {} : { contextId: conversationId }),
          agent,
          pollUrl: `/api/a2a/task/${correlationId}`,
        },
      });
    }

    // Block up to the reply timeout (replyPromise is defined on this path).
    const reply = await replyPromise!;

    // Timed out — task is still running. TaskTracker will deliver the result to
    // the reply topic + an autonomous.outcome event when it finishes; the caller
    // can poll GET /api/a2a/task/{correlationId} to retrieve it.
    if (!reply) {
      return Response.json({
        success: true,
        data: {
          pending: true,
          response: null,
          taskState: "working",
          correlationId,
          ...(done ? {} : { contextId: conversationId }),
          agent,
          pollUrl: `/api/a2a/task/${correlationId}`,
        },
      });
    }

    // Mirror the agent's response (or error) for o11y.
    const responseText = reply.content ?? "";
    ctx.bus.publish("agent.chat.inbound", {
      id: crypto.randomUUID(),
      correlationId,
      topic: "agent.chat.inbound",
      timestamp: Date.now(),
      payload: {
        from: agent, to: "ava", contextId: conversationId,
        message: reply.error ? `(error) ${reply.error}` : responseText, skill, done,
      },
    });
    if (AGENT_OPS_CHANNEL) {
      const shown = reply.error ?? responseText;
      const preview = shown.length > 500 ? shown.slice(0, 500) + "…" : shown;
      ctx.bus.publish(`message.outbound.discord.push.${AGENT_OPS_CHANNEL}`, {
        id: crypto.randomUUID(),
        correlationId,
        topic: `message.outbound.discord.push.${AGENT_OPS_CHANNEL}`,
        timestamp: Date.now(),
        payload: { content: `**${agent} → ava** (${reply.taskState ?? (reply.error ? "failed" : "completed")})\n${preview}` },
      });
    }

    if (reply.error) {
      const status = reply.error.startsWith("No executor registered") ? 404 : 502;
      return Response.json(
        { success: false, error: reply.error, data: { correlationId, agent, taskState: reply.taskState ?? "failed" } },
        { status },
      );
    }

    return Response.json({
      success: true,
      data: {
        response: responseText,
        // Omit contextId/taskId when done — signals conversation end.
        ...(done ? {} : {
          contextId: reply.contextId ?? conversationId,
          ...(reply.taskId ? { taskId: reply.taskId } : {}),
        }),
        taskState: reply.taskState ?? "completed",
        correlationId,
        agent,
        ...(reply.usage ? { usage: reply.usage } : {}),
        ...(reply.durationMs !== undefined ? { durationMs: reply.durationMs } : {}),
        ...(reply.costUsd !== undefined ? { costUsd: reply.costUsd } : {}),
        ...(reply.confidence !== undefined ? { confidence: reply.confidence } : {}),
        ...(reply.confidenceExplanation ? { confidenceExplanation: reply.confidenceExplanation } : {}),
      },
    });
  }

  /**
   * GET /api/a2a/task/:correlationId — fetch the result of a dispatch that a
   * chat caller stopped awaiting (timed out). Resolves in this order:
   *   1. SkillResponseCache — terminal result (in-process or A2A)        → done
   *   2. TaskTracker — a tracked, in-flight long-running A2A task        → working (+taskId)
   *   3. activeDispatchCheck — an in-flight in-process dispatch          → working
   *   4. none of the above                                              → unknown
   *
   * Returns one of:
   *   { done: true, response, error?, taskState, … }   — terminal result available
   *   { pending: true, taskState: "working", taskId? } — still running (taskId only for A2A)
   *   { pending: false, taskState: "unknown" }         — never seen / aged out
   */
  function handleTaskPoll(req: Request, params: Record<string, string>): Response {
    if (ctx.apiKey && req.headers.get("X-API-Key") !== ctx.apiKey) {
      return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    const correlationId = params.correlationId;
    if (!correlationId) {
      return Response.json({ success: false, error: "correlationId required" }, { status: 400 });
    }

    const result = ctx.skillResponseCache?.get(correlationId);
    if (result) {
      return Response.json({
        success: true,
        data: {
          done: true,
          response: result.content ?? null,
          ...(result.error ? { error: result.error } : {}),
          taskState: result.taskState ?? (result.error ? "failed" : "completed"),
          correlationId,
          ...(result.taskId ? { taskId: result.taskId } : {}),
          ...(result.contextId ? { contextId: result.contextId } : {}),
          ...(result.usage ? { usage: result.usage } : {}),
          ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
          ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
        },
      });
    }

    const tracked = ctx.taskTracker?.getAll().find((t) => t.correlationId === correlationId);
    if (tracked) {
      return Response.json({
        success: true,
        data: { pending: true, taskState: "working", correlationId, taskId: tracked.taskId, agent: tracked.agentName },
      });
    }

    // In-flight in-process dispatch: no cached result yet, and TaskTracker only
    // covers A2A. The dispatcher knows it's still executing — report "working"
    // so the caller can keep polling instead of mistaking it for "unknown".
    if (ctx.activeDispatchCheck?.(correlationId)) {
      return Response.json({
        success: true,
        data: { pending: true, taskState: "working", correlationId },
      });
    }

    return Response.json({
      success: true,
      data: {
        pending: false,
        taskState: "unknown",
        correlationId,
        note: "No in-flight dispatch, tracked task, or cached result — it may never have been dispatched, or its result aged out.",
      },
    });
  }

  /**
   * POST /api/a2a/delegate — fire-and-forget task dispatch to an agent.
   *
   * Body: { agent, skill, message, projectSlug?, dispatcherAgent? }
   * Returns: { success, data: { correlationId, message, pollUrl } }
   */
  async function handleDelegate(req: Request): Promise<Response> {
    if (ctx.apiKey && req.headers.get("X-API-Key") !== ctx.apiKey) {
      return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });
    }

    const agent = body.agent as string | undefined;
    const skill = body.skill as string | undefined;
    const message = body.message as string | undefined;
    const projectSlug = body.projectSlug as string | undefined;
    const dispatcherAgent = typeof body.dispatcherAgent === "string" ? body.dispatcherAgent : undefined;

    if (!agent || !skill || !message) {
      return Response.json(
        { success: false, error: "agent, skill, and message are required" },
        { status: 400 },
      );
    }

    const correlationId = crypto.randomUUID();

    ctx.bus.publish("agent.skill.request", {
      id: crypto.randomUUID(),
      correlationId,
      topic: "agent.skill.request",
      timestamp: Date.now(),
      payload: {
        skill,
        content: message,
        targets: [agent],
        ...(projectSlug ? { projectSlug } : {}),
        ...(dispatcherAgent ? { meta: { dispatcherAgent } } : {}),
      },
    });

    return Response.json({
      success: true,
      data: {
        correlationId,
        message: `Task delegated to ${agent} (skill: ${skill})`,
        pollUrl: `/api/a2a/task/${correlationId}`,
      },
    });
  }

  return [
    { method: "POST", path: "/api/a2a/chat", handler: (req) => handleChat(req) },
    { method: "POST", path: "/api/a2a/delegate", handler: (req) => handleDelegate(req) },
    { method: "GET", path: "/api/a2a/task/:correlationId", handler: (req, params) => handleTaskPoll(req, params) },
  ];
}
