/**
 * research.ts — HTTP surface over the ResearchStore.
 *
 * Backs the researcher agent's `research_search` / `research_ingest` /
 * `research_stats` DeepAgent tools (tool → http → here → store), mirroring how
 * every other in-process tool reaches server state. Also reused by the
 * automated research ceremony (R4). Auth: admin X-API-Key / Bearer, matching
 * the rest of the agent-facing API.
 */

import type { ApiContext } from "./types.ts";
import type { Route } from "./types.ts";
import type { ResearchKind } from "../knowledge/research-store.ts";

function authed(ctx: ApiContext, req: Request): boolean {
  if (!ctx.apiKey) return true; // open in dev / no key configured
  const key = ctx.apiKey;
  return req.headers.get("x-api-key") === key || req.headers.get("authorization") === `Bearer ${key}`;
}

const KINDS: ResearchKind[] = ["paper", "finding", "digest", "model_release"];

export function createRoutes(ctx: ApiContext): Route[] {
  const unavailable = () =>
    Response.json({ success: false, error: "Research store not configured" }, { status: 503 });

  return [
    {
      method: "POST",
      path: "/api/research/search",
      handler: async (req) => {
        if (!authed(ctx, req)) return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
        if (!ctx.researchStore) return unavailable();
        let body: Record<string, unknown>;
        try { body = (await req.json()) as Record<string, unknown>; }
        catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }
        const query = typeof body.query === "string" ? body.query : "";
        if (!query.trim()) return Response.json({ success: false, error: "query is required" }, { status: 400 });
        const k = typeof body.k === "number" && body.k > 0 ? Math.min(body.k, 25) : 5;
        const kind = KINDS.includes(body.kind as ResearchKind) ? (body.kind as ResearchKind) : undefined;
        const hits = await ctx.researchStore.hybridSearch(query, k, kind);
        return Response.json({ success: true, data: { hits } });
      },
    },
    {
      method: "POST",
      path: "/api/research/ingest",
      handler: async (req) => {
        if (!authed(ctx, req)) return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
        if (!ctx.researchStore) return unavailable();
        let body: Record<string, unknown>;
        try { body = (await req.json()) as Record<string, unknown>; }
        catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }
        const kind = body.kind as ResearchKind;
        const content = typeof body.content === "string" ? body.content : "";
        if (!KINDS.includes(kind)) return Response.json({ success: false, error: `kind must be one of ${KINDS.join(", ")}` }, { status: 400 });
        if (!content.trim()) return Response.json({ success: false, error: "content is required" }, { status: 400 });
        const id = await ctx.researchStore.addChunk({
          kind,
          content,
          title: typeof body.title === "string" ? body.title : undefined,
          source: typeof body.source === "string" ? body.source : undefined,
          sourceType: typeof body.sourceType === "string" ? body.sourceType : undefined,
          url: typeof body.url === "string" ? body.url : undefined,
          metadata: body.metadata && typeof body.metadata === "object" ? (body.metadata as Record<string, unknown>) : undefined,
        });
        if (id === null) return Response.json({ success: false, error: "ingest failed" }, { status: 500 });
        return Response.json({ success: true, data: { id } });
      },
    },
    {
      method: "GET",
      path: "/api/research/stats",
      handler: async (req) => {
        if (!authed(ctx, req)) return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
        if (!ctx.researchStore) return unavailable();
        return Response.json({ success: true, data: ctx.researchStore.stats() });
      },
    },
  ];
}
