/**
 * GET /api/flows — durable execution log for the orchestration canvas (ADR-0008 P1).
 *
 *   GET /api/flows?since=<ms>&status=<s>&limit=<n>   recent flow items, newest first
 *   GET /api/flows/:id                                one flow item (id = `skill-<correlationId>`)
 *
 * Backed by the FlowStore (persisted flow.item.*). Returns 503 when the store
 * isn't wired, so the canvas can tell "no flows" from "feature disabled".
 */

import type { Route, ApiContext } from "./types.ts";

export function createRoutes(ctx: ApiContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/flows",
      handler: (req) => {
        if (!ctx.flowStore?.isReady()) {
          return Response.json({ success: false, error: "flow-store unavailable" }, { status: 503 });
        }
        const url = new URL(req.url);
        const sinceRaw = url.searchParams.get("since");
        const since = sinceRaw ? Number.parseInt(sinceRaw, 10) : undefined;
        const status = url.searchParams.get("status") || undefined;
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
        const flows = ctx.flowStore.recent({
          sinceMs: Number.isFinite(since) ? since : undefined,
          status,
          limit: Number.isFinite(limit) ? limit : undefined,
        });
        return Response.json({ success: true, data: { count: flows.length, flows } });
      },
    },
    {
      method: "GET",
      path: "/api/flows/:id",
      handler: (_req, p) => {
        if (!ctx.flowStore?.isReady()) {
          return Response.json({ success: false, error: "flow-store unavailable" }, { status: 503 });
        }
        const flow = ctx.flowStore.get(p.id);
        if (!flow) {
          return Response.json({ success: false, error: `flow "${p.id}" not found` }, { status: 404 });
        }
        return Response.json({ success: true, data: flow });
      },
    },
  ];
}
