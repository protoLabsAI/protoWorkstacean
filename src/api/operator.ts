/**
 * Operator comms routes — entry points for agents to message the operator.
 *
 * Thin HTTP shim: validates payload, publishes `operator.message.request`.
 * OperatorRoutingPlugin subscribes, picks transport(s), dispatches.
 */

import type { Route, ApiContext } from "./types.ts";
import type { OperatorMessageRequest } from "../../lib/plugins/operator-routing.ts";

const VALID_URGENCIES = ["low", "normal", "high", "urgent"] as const;

export function createRoutes(ctx: ApiContext): Route[] {
  async function handleMessage(req: Request): Promise<Response> {
    // Auth: admin OR any registered per-agent key (all fleet agents may message the operator).
    if (ctx.apiKey) {
      const headerKey = req.headers.get("X-API-Key");
      const bearer = req.headers.get("Authorization");
      const apiKey = headerKey ?? (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null);
      const isAdmin = apiKey === ctx.apiKey;
      const isAgent = ctx.agentKeys?.resolve(apiKey) != null;
      if (!isAdmin && !isAgent) {
        return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
      }
    }

    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; }
    catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }

    const message = body.message as string | undefined;
    const urgencyIn = (body.urgency as string | undefined) ?? "normal";
    const topic = body.topic as string | undefined;
    const from = (body.from as string | undefined) ?? "unknown";

    if (!message || typeof message !== "string" || message.trim().length === 0) {
      return Response.json({ success: false, error: "message is required" }, { status: 400 });
    }
    if (!(VALID_URGENCIES as readonly string[]).includes(urgencyIn)) {
      return Response.json({ success: false, error: `urgency must be one of: ${VALID_URGENCIES.join(", ")}` }, { status: 400 });
    }

    const correlationId = crypto.randomUUID();
    const payload: OperatorMessageRequest = {
      type: "operator_message_request",
      correlationId,
      message: message.trim(),
      urgency: urgencyIn as OperatorMessageRequest["urgency"],
      ...(topic ? { topic } : {}),
      from,
    };

    // Subscribe to the failure event BEFORE publishing — if routing throws
    // (no channel available) we get a failed event and return 503 so the
    // agent's tool call visibly fails, not silently succeeds. See
    // feedback_fail_fast_and_loud memory.
    const failedTopic = `operator.message.failed.${correlationId}`;
    const failurePromise = new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 250);
      (timer as { unref?: () => void }).unref?.();
      const subId = ctx.bus.subscribe(failedTopic, "operator-api", (msg) => {
        clearTimeout(timer);
        ctx.bus.unsubscribe(subId);
        const p = msg.payload as { error?: string };
        resolve(p?.error ?? "unknown failure");
      });
    });

    ctx.bus.publish("operator.message.request", {
      id: crypto.randomUUID(),
      correlationId,
      topic: "operator.message.request",
      timestamp: Date.now(),
      payload,
    });

    const failure = await failurePromise;
    if (failure) {
      return Response.json(
        { success: false, error: failure },
        { status: 503 },
      );
    }

    return Response.json({ success: true, data: { correlationId } });
  }

  return [
    { method: "POST", path: "/api/operator/message", handler: req => handleMessage(req) },
  ];
}
