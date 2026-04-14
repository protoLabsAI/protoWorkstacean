/**
 * Board write routes — proxy feature create/update to the protoMaker Studio server.
 *
 * Ava uses these to write to the board after reviewing Quinn's triage reports.
 * Read access is Quinn's domain — she uses get_pr_pipeline and similar tools.
 */

import type { Route, ApiContext } from "./types.ts";
import { HttpClient } from "../services/http-client.ts";

const STUDIO_URL = process.env.AVA_BASE_URL ?? "http://automaker-server:3008";

const studioHttp = new HttpClient({
  baseUrl: STUDIO_URL,
  timeoutMs: 30_000,
});

export function createRoutes(ctx: ApiContext): Route[] {
  async function handleCreateFeature(req: Request): Promise<Response> {
    if (ctx.apiKey && req.headers.get("X-API-Key") !== ctx.apiKey) {
      return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; }
    catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }

    const projectPath = body.projectPath as string | undefined;
    const title = body.title as string | undefined;

    if (!projectPath || !title) {
      return Response.json(
        { success: false, error: "projectPath and title are required" },
        { status: 400 },
      );
    }

    try {
      const resp = await studioHttp.fetch(`${STUDIO_URL}/features/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath,
          title,
          description: body.description ?? "",
          status: body.status ?? "backlog",
          priority: body.priority,
          complexity: body.complexity,
          projectSlug: body.projectSlug,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "(no body)");
        return Response.json({ success: false, error: `Studio: ${resp.status} ${errText}` }, { status: resp.status });
      }

      const data = await resp.json();
      return Response.json({ success: true, data });
    } catch (e) {
      return Response.json({ success: false, error: String(e) }, { status: 502 });
    }
  }

  async function handleUpdateFeature(req: Request): Promise<Response> {
    if (ctx.apiKey && req.headers.get("X-API-Key") !== ctx.apiKey) {
      return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; }
    catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }

    const projectPath = body.projectPath as string | undefined;
    const featureId = body.featureId as string | undefined;

    if (!projectPath || !featureId) {
      return Response.json(
        { success: false, error: "projectPath and featureId are required" },
        { status: 400 },
      );
    }

    try {
      const resp = await studioHttp.fetch(`${STUDIO_URL}/features/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectPath,
          featureId,
          ...(body.title != null ? { title: body.title } : {}),
          ...(body.description != null ? { description: body.description } : {}),
          ...(body.status != null ? { status: body.status } : {}),
          ...(body.priority != null ? { priority: body.priority } : {}),
          ...(body.complexity != null ? { complexity: body.complexity } : {}),
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "(no body)");
        return Response.json({ success: false, error: `Studio: ${resp.status} ${errText}` }, { status: resp.status });
      }

      const data = await resp.json();
      return Response.json({ success: true, data });
    } catch (e) {
      return Response.json({ success: false, error: String(e) }, { status: 502 });
    }
  }

  return [
    { method: "POST", path: "/api/board/features/create", handler: (req) => handleCreateFeature(req) },
    { method: "POST", path: "/api/board/features/update", handler: (req) => handleUpdateFeature(req) },
  ];
}
