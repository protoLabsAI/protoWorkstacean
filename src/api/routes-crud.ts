/**
 * Routes control-plane API (ADR-0008 P2 — wiring authoring).
 *
 * The canvas's draw-edge writes a route here:
 *   GET    /api/routes          list live routes (render as canvas edges)
 *   POST   /api/routes          validate + persist a route (admin-keyed)
 *   DELETE /api/routes/:name    remove a route (admin-keyed)
 *
 * Writes publish `command.route.{upsert,remove}`; ControlPlaneRegistrar is the
 * sole writer of `workspace/routes.d/`. RoutesPlugin hot-reloads the change.
 * Mirrors agents-crud — same auth, same registrar handoff, no new write path.
 */

import { join, resolve } from "node:path";
import type { Route, ApiContext } from "./types.ts";
import { loadRouteEntries, parseRouteDefinition, routeToYaml } from "../routes/route-definition.ts";

function safeFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
}

export function createRoutes(ctx: ApiContext): Route[] {
  const routesdDir = join(ctx.workspaceDir, "routes.d");

  const authorized = (req: Request): boolean => {
    if (!ctx.apiKey) return true;
    if (req.headers.get("x-api-key") === ctx.apiKey) return true;
    return req.headers.get("authorization") === `Bearer ${ctx.apiKey}`;
  };
  const unauthorized = () => Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const badJson = () => Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });

  function command(topic: string, name: string, payload: Record<string, unknown>): void {
    ctx.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic,
      timestamp: Date.now(),
      payload: { name, ...payload },
      source: { interface: "api" },
    });
  }

  return [
    {
      // List live routes — the canvas renders these as wiring edges.
      method: "GET",
      path: "/api/routes",
      handler: () => Response.json({ success: true, data: { routes: loadRouteEntries(routesdDir) } }),
    },
    {
      // Author a route: validate, then hand to the registrar (→ routes.d/, hot-reloaded).
      method: "POST",
      path: "/api/routes",
      handler: async (req) => {
        if (!authorized(req)) return unauthorized();
        let body: unknown;
        try { body = await req.json(); } catch { return badJson(); }
        let def;
        try { def = parseRouteDefinition(body, "(request body)"); } catch (err) {
          return Response.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 });
        }
        const safe = safeFileName(def.name);
        if (!safe) return Response.json({ success: false, error: "name produced an empty filename" }, { status: 400 });
        const file = resolve(join(routesdDir, `${safe}.yaml`));
        command("command.route.upsert", def.name, { file, yaml: routeToYaml(def) });
        return Response.json({ success: true, data: { name: def.name } }, { status: 201 });
      },
    },
    {
      // Remove a route by name.
      method: "DELETE",
      path: "/api/routes/:name",
      handler: (req, p) => {
        if (!authorized(req)) return unauthorized();
        const name = p.name;
        const safe = safeFileName(name);
        if (!safe) return Response.json({ success: false, error: "invalid name" }, { status: 400 });
        const file = resolve(join(routesdDir, `${safe}.yaml`));
        command("command.route.remove", name, { file });
        return Response.json({ success: true, data: { name } });
      },
    },
  ];
}
