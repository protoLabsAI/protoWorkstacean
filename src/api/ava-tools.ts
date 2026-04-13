/**
 * Ava operational tools — chat with agent (multi-turn A2A) + delegate task.
 *
 * These endpoints back Ava's chat_with_agent and delegate_task bus tools.
 * chat_with_agent calls A2AExecutor directly (synchronous, bypasses the bus)
 * for multi-turn conversation with contextId continuity.
 */

import type { Route, ApiContext } from "./types.ts";
import type { SkillRequest } from "../executor/types.ts";

const AGENT_OPS_CHANNEL = process.env.DISCORD_AGENT_OPS_CHANNEL ?? "";

export function createRoutes(ctx: ApiContext): Route[] {
  /**
   * POST /api/a2a/chat — synchronous multi-turn conversation with an agent.
   *
   * Body: { agent, message, contextId?, skill?, done? }
   * Returns: { success, data: { response, contextId?, correlationId } }
   *
   * When done=true, the response omits contextId to signal conversation end.
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

    if (!agent || !message) {
      return Response.json(
        { success: false, error: "agent and message are required" },
        { status: 400 },
      );
    }

    // Resolve the agent's executor by name
    const executor = ctx.executorRegistry.resolve(skill, [agent]);
    if (!executor) {
      return Response.json(
        { success: false, error: `No executor found for agent "${agent}"` },
        { status: 404 },
      );
    }

    const correlationId = crypto.randomUUID();
    const conversationId = contextId ?? crypto.randomUUID();

    const skillReq: SkillRequest = {
      skill,
      content: message,
      correlationId,
      contextId: conversationId,
      replyTopic: `agent.skill.response.${correlationId}`,
      payload: {
        skill,
        content: message,
        targets: [agent],
      },
    };

    try {
      // Publish Ava's outbound message for o11y (agent-ops channel)
      ctx.bus.publish("agent.chat.outbound", {
        id: crypto.randomUUID(),
        correlationId,
        topic: "agent.chat.outbound",
        timestamp: Date.now(),
        payload: {
          from: "ava",
          to: agent,
          contextId: conversationId,
          message,
          skill,
        },
      });

      // Post to Discord agent-ops channel so agent conversations are visible
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

      const result = await executor.execute(skillReq);

      // Publish agent's response for o11y
      ctx.bus.publish("agent.chat.inbound", {
        id: crypto.randomUUID(),
        correlationId,
        topic: "agent.chat.inbound",
        timestamp: Date.now(),
        payload: {
          from: agent,
          to: "ava",
          contextId: conversationId,
          message: result.text,
          skill,
          done,
        },
      });

      // Post agent response to Discord
      if (AGENT_OPS_CHANNEL) {
        const responsePreview = result.text.length > 500
          ? result.text.slice(0, 500) + "…"
          : result.text;
        ctx.bus.publish(`message.outbound.discord.push.${AGENT_OPS_CHANNEL}`, {
          id: crypto.randomUUID(),
          correlationId,
          topic: `message.outbound.discord.push.${AGENT_OPS_CHANNEL}`,
          timestamp: Date.now(),
          payload: {
            content: `**${agent} → ava** (${result.data?.taskState ?? "completed"})\n${responsePreview}`,
          },
        });
      }

      const remoteTaskId = result.data?.taskId;
      const remoteContextId = result.data?.contextId ?? conversationId;
      const taskState = result.data?.taskState ?? "completed";

      return Response.json({
        success: true,
        data: {
          response: result.text,
          // Omit contextId/taskId when done — signals conversation end
          ...(done ? {} : {
            contextId: remoteContextId,
            ...(remoteTaskId ? { taskId: remoteTaskId } : {}),
          }),
          taskState,
          correlationId,
          agent,
        },
      });
    } catch (e) {
      return Response.json(
        {
          success: false,
          error: e instanceof Error ? e.message : String(e),
        },
        { status: 502 },
      );
    }
  }

  /**
   * POST /api/a2a/delegate — fire-and-forget task dispatch to an agent.
   *
   * Body: { agent, skill, message, projectSlug? }
   * Returns: { success, data: { correlationId, message } }
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

    if (!agent || !skill || !message) {
      return Response.json(
        { success: false, error: "agent, skill, and message are required" },
        { status: 400 },
      );
    }

    const correlationId = crypto.randomUUID();
    const topic = "agent.skill.request";

    ctx.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId,
      topic,
      timestamp: Date.now(),
      payload: {
        skill,
        content: message,
        targets: [agent],
        ...(projectSlug ? { projectSlug } : {}),
      },
    });

    return Response.json({
      success: true,
      data: {
        correlationId,
        message: `Task delegated to ${agent} (skill: ${skill})`,
      },
    });
  }

  return [
    { method: "POST", path: "/api/a2a/chat", handler: (req) => handleChat(req) },
    { method: "POST", path: "/api/a2a/delegate", handler: (req) => handleDelegate(req) },
  ];
}
