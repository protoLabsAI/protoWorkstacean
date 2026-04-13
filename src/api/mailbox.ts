/**
 * Mailbox API — HTTP endpoints for the DM context mailbox.
 *
 * Remote agents poll GET /api/mailbox/:contextId between tool calls to pick up
 * messages the user sent while the agent was working. SkillDispatcherPlugin also
 * auto-drains on execution completion, so this endpoint is a "best-effort early
 * delivery" path and a useful debugging tool.
 *
 * Routes:
 *   GET  /api/mailbox/:contextId          → drain + return pending messages
 *   GET  /api/mailbox/:contextId?peek=true → peek without draining
 *   POST /api/mailbox/:contextId          → push a message (API-key-gated)
 */

import type { Route, ApiContext } from "./types.ts";
import { ContextMailbox, type MailboxMessage } from "../../lib/dm/context-mailbox.ts";

export function createRoutes(mailbox: ContextMailbox, ctx: ApiContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/mailbox/:contextId",
      handler: (req, params) => {
        const url = new URL(req.url);
        const peek = url.searchParams.get("peek") === "true";
        const messages = peek ? mailbox.peek(params.contextId) : mailbox.drain(params.contextId);
        return Response.json({
          success: true,
          contextId: params.contextId,
          messages,
          formatted: messages.length > 0 ? ContextMailbox.format(messages) : null,
        });
      },
    },
    {
      method: "POST",
      path: "/api/mailbox/:contextId",
      handler: async (req, params) => {
        if (ctx.apiKey && req.headers.get("X-API-Key") !== ctx.apiKey) {
          return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
        }

        let body: { content?: string; sender?: string };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });
        }

        if (!body.content) {
          return Response.json({ success: false, error: "content is required" }, { status: 400 });
        }

        mailbox.push(params.contextId, {
          content: body.content,
          sender: body.sender,
          receivedAt: Date.now(),
        });

        return Response.json({ success: true });
      },
    },
  ];
}
