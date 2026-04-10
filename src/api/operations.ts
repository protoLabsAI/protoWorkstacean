/**
 * Operations routes — ceremonies, skills, channels, HITL, onboard, publish.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Route, ApiContext } from "./types.ts";
import { serveWorkspaceYaml } from "./types.ts";

export function createRoutes(ctx: ApiContext): Route[] {
  const hitlPlugin = ctx.plugins.find(p => p.name === "hitl") as { getPendingRequests(): unknown } | undefined;

  function handleGetCeremonies(): Response {
    const ceremoniesDir = join(ctx.workspaceDir, "ceremonies");
    if (!existsSync(ceremoniesDir)) return Response.json({ success: true, data: [] });
    const files = readdirSync(ceremoniesDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
    const ceremonies: unknown[] = [];
    for (const file of files) {
      try {
        const parsed = parseYaml(readFileSync(join(ceremoniesDir, file), "utf8")) as Record<string, unknown>;
        ceremonies.push(parsed);
      } catch { /* skip malformed */ }
    }
    return Response.json({ success: true, data: ceremonies });
  }

  async function handleRunCeremony(req: Request, ceremonyId: string): Promise<Response> {
    if (ctx.apiKey && req.headers.get("X-API-Key") !== ctx.apiKey) {
      return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!/^[\w.\-]+$/.test(ceremonyId)) {
      return Response.json({ success: false, error: "Invalid ceremony id" }, { status: 400 });
    }
    const topic = `ceremony.${ceremonyId}.execute`;
    ctx.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic,
      timestamp: Date.now(),
      payload: { type: "manual.execute", triggeredBy: "api" },
    });
    return Response.json({ success: true, message: `Ceremony "${ceremonyId}" triggered` });
  }

  function handleGetAgentSkills(agentName: string): Response {
    const agentsPath = join(ctx.workspaceDir, "agents.yaml");
    if (!existsSync(agentsPath)) {
      return Response.json({ success: false, error: "agents.yaml not found" }, { status: 404 });
    }
    try {
      const parsed = parseYaml(readFileSync(agentsPath, "utf8")) as {
        agents?: Array<{ name: string; skills?: unknown[] }>;
      };
      const agent = (parsed.agents ?? []).find(a => a.name === agentName);
      if (!agent) return Response.json({ success: false, error: `Agent "${agentName}" not found` }, { status: 404 });
      return Response.json({ success: true, data: { name: agent.name, skills: agent.skills ?? [] } });
    } catch {
      return Response.json({ success: false, error: "Failed to parse agents.yaml" }, { status: 500 });
    }
  }

  async function handlePublish(req: Request): Promise<Response> {
    if (ctx.apiKey && req.headers.get("X-API-Key") !== ctx.apiKey) {
      return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; }
    catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }
    const topic = (body.topic as string) ?? "#";
    ctx.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: (body.correlationId as string) ?? crypto.randomUUID(),
      topic,
      timestamp: Date.now(),
      payload: body.payload ?? body,
    });
    return Response.json({ success: true });
  }

  async function handleOnboard(req: Request): Promise<Response> {
    if (ctx.apiKey && req.headers.get("X-API-Key") !== ctx.apiKey) {
      return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
    }
    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; }
    catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }
    const topic = "message.inbound.onboard";
    ctx.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic,
      timestamp: Date.now(),
      payload: body,
    });
    return Response.json({ success: true, message: "Onboarding request published" });
  }

  return [
    { method: "GET",  path: "/health",                  handler: () => Response.json({ status: "ok", timestamp: Date.now() }) },
    { method: "POST", path: "/publish",                 handler: (req) => handlePublish(req) },
    { method: "POST", path: "/api/onboard",             handler: (req) => handleOnboard(req) },
    { method: "GET",  path: "/api/projects",            handler: () => serveWorkspaceYaml(ctx.workspaceDir, "projects.yaml", "projects") },
    { method: "GET",  path: "/api/agents",              handler: () => serveWorkspaceYaml(ctx.workspaceDir, "agents.yaml", "agents") },
    { method: "GET",  path: "/api/goals",               handler: () => serveWorkspaceYaml(ctx.workspaceDir, "goals.yaml", "goals") },
    { method: "GET",  path: "/api/ceremonies",          handler: () => handleGetCeremonies() },
    { method: "POST", path: "/api/ceremonies/:id/run",  handler: (req, p) => handleRunCeremony(req, p.id) },
    { method: "GET",  path: "/api/skills/:agentName",   handler: (_, p) => handleGetAgentSkills(p.agentName) },
    { method: "GET",  path: "/api/channels",            handler: () => Response.json({ success: true, data: [] }) },
    { method: "GET",  path: "/api/hitl/pending",        handler: () => Response.json({ success: true, data: hitlPlugin?.getPendingRequests() ?? [] }) },
  ];
}
