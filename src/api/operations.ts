/**
 * Operations routes — ceremonies, skills, channels, HITL, onboard, publish.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Route, ApiContext } from "./types.ts";
import { serveWorkspaceYaml } from "./types.ts";
import type { CallerIdentity } from "../../lib/auth/agent-keys.ts";
import { getPendingHumanInput } from "./human-input.ts";
import { safeKeyEqual, isPublishTopicDenied } from "../../lib/runtime-env.ts";

export function createRoutes(ctx: ApiContext): Route[] {

  /**
   * Resolve a request to a CallerIdentity. Returns null when auth fails:
   *   - If ctx.apiKey is unset, all requests are allowed as admin (legacy).
   *   - With ctx.apiKey set, the X-API-Key (or Bearer) header must match
   *     either the admin key OR a per-agent key registered in ctx.agentKeys.
   *   - With ctx.agentKeys configured, agent-scoped callers get
   *     {agentName, isAdmin: false}; admin callers get {isAdmin: true}.
   */
  function authenticateCaller(req: Request): CallerIdentity | null {
    if (!ctx.apiKey) return { isAdmin: true };
    const headerKey = req.headers.get("X-API-Key");
    const bearer = req.headers.get("Authorization");
    const apiKey = headerKey ?? (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null);
    if (ctx.agentKeys) {
      const resolved = ctx.agentKeys.resolve(apiKey);
      if (resolved) return resolved;
    }
    // Fallback: ctx.apiKey direct comparison (single-key legacy mode when
    // agentKeys isn't configured). Constant-time to avoid a timing oracle.
    if (safeKeyEqual(apiKey, ctx.apiKey)) return { isAdmin: true };
    return null;
  }

  /** Standard 401 response. */
  function unauthorized(): Response {
    return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  function handleGetCeremonies(req: Request): Response {
    const caller = authenticateCaller(req);
    if (!caller) return unauthorized();

    // ?all=true returns every ceremony regardless of owner. Admin-only.
    // Default behavior:
    //   - admin caller (no agentName) → sees all
    //   - agent-scoped caller → sees only own ceremonies
    // Check is BEFORE the dir-existence early-return so unauthorized callers
    // can't probe state by passing the flag.
    const allRequested = new URL(req.url).searchParams.get("all") === "true";
    if (allRequested && !caller.isAdmin) return unauthorized();

    const ceremoniesDir = join(ctx.workspaceDir, "ceremonies");
    if (!existsSync(ceremoniesDir)) return Response.json({ success: true, data: [] });

    const files = readdirSync(ceremoniesDir).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
    const ceremonies: Record<string, unknown>[] = [];
    for (const file of files) {
      try {
        const parsed = parseYaml(readFileSync(join(ceremoniesDir, file), "utf8")) as Record<string, unknown>;
        if (caller.isAdmin || caller.agentName === parsed.createdBy) {
          ceremonies.push(parsed);
        }
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
    // Admin-only — `/publish` injects directly onto the internal bus.
    const caller = authenticateCaller(req);
    if (!caller?.isAdmin) return unauthorized();
    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; }
    catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }
    // Require an explicit topic — no silent `"#"` wildcard publish.
    const topic = typeof body.topic === "string" ? body.topic.trim() : "";
    if (!topic) {
      return Response.json({ success: false, error: "Missing 'topic'" }, { status: 400 });
    }
    // Reject internal control-plane topics — `/publish` is for external
    // lifecycle/event injection (feature.*, hitl.request.*, board/incident),
    // never for forging agent.skill.request / operator.message.request /
    // inbound messages / scheduled triggers.
    if (isPublishTopicDenied(topic)) {
      console.warn(`[publish] rejected denied topic "${topic}" from ${caller.agentName ?? "admin"}`);
      return Response.json(
        { success: false, error: `Topic "${topic}" may not be published via /publish (internal control-plane topic)` },
        { status: 403 },
      );
    }
    ctx.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: (body.correlationId as string) ?? crypto.randomUUID(),
      topic,
      timestamp: Date.now(),
      payload: body.payload ?? body,
    });
    return Response.json({ success: true });
  }

  /**
   * Readiness probe (#795). Gates on LOCAL invariants the instance needs to
   * serve (sqlite open). The LLM gateway is probed for visibility but does NOT
   * gate readiness — an external gateway outage shouldn't restart-loop the
   * container (agent runs fail fast via #794 instead). `/health` stays a cheap
   * liveness check.
   */
  async function handleReady(): Promise<Response> {
    const sqlite = ctx.telemetry ? ctx.telemetry.healthCheck() : true;
    let gateway: boolean | "unconfigured" = "unconfigured";
    const gw = process.env.LLM_GATEWAY_URL;
    if (gw) {
      try {
        const r = await fetch(new URL("/health", gw), { signal: AbortSignal.timeout(2000) });
        gateway = r.ok;
      } catch { gateway = false; }
    }
    const ready = sqlite;
    return Response.json(
      { status: ready ? "ready" : "unready", sqlite, gateway, timestamp: Date.now() },
      { status: ready ? 200 : 503 },
    );
  }

  async function handleOnboard(req: Request): Promise<Response> {
    const caller = authenticateCaller(req);
    if (!caller?.isAdmin) return unauthorized();
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

  async function handleCreateCeremony(req: Request): Promise<Response> {
    const caller = authenticateCaller(req);
    if (!caller) return unauthorized();

    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; }
    catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }

    const id = body.id as string | undefined;
    const name = body.name as string | undefined;
    const schedule = body.schedule as string | undefined;
    const skill = body.skill as string | undefined;

    if (!id || !name || !schedule || !skill) {
      return Response.json({ success: false, error: "id, name, schedule, and skill are required" }, { status: 400 });
    }
    if (!/^[\w.\-]+$/.test(id)) {
      return Response.json({ success: false, error: "Invalid ceremony id (alphanumeric, dots, dashes only)" }, { status: 400 });
    }

    // Stamp createdBy from the caller. Admin callers may override via the
    // body (so an operator can create on behalf of an agent); agent-scoped
    // callers always own what they create.
    const createdBy = caller.isAdmin
      ? ((body.createdBy as string | undefined) ?? "system")
      : caller.agentName!;

    const ceremony = {
      id,
      name,
      schedule,
      skill,
      targets: (body.targets as string[]) ?? ["all"],
      notifyChannel: (body.notifyChannel as string) ?? "",
      enabled: body.enabled !== false,
      createdBy,
    };

    const ceremoniesDir = join(ctx.workspaceDir, "ceremonies");
    if (!existsSync(ceremoniesDir)) mkdirSync(ceremoniesDir, { recursive: true });
    writeFileSync(join(ceremoniesDir, `${id}.yaml`), stringifyYaml(ceremony));

    return Response.json({ success: true, data: ceremony });
  }

  /**
   * Ownership check shared by update + delete. Admin always passes;
   * agent-scoped caller must equal the ceremony's createdBy.
   * Returns null on success, a Response on failure (caller returns it).
   */
  function checkOwnership(caller: CallerIdentity, ceremony: Record<string, unknown>, id: string): Response | null {
    if (caller.isAdmin) return null;
    if (caller.agentName && ceremony.createdBy === caller.agentName) return null;
    return Response.json(
      {
        success: false,
        error: `Forbidden — ceremony "${id}" is owned by "${ceremony.createdBy ?? "system"}", not "${caller.agentName}"`,
      },
      { status: 403 },
    );
  }

  async function handleUpdateCeremony(req: Request, id: string): Promise<Response> {
    const caller = authenticateCaller(req);
    if (!caller) return unauthorized();

    const filePath = join(ctx.workspaceDir, "ceremonies", `${id}.yaml`);
    if (!existsSync(filePath)) {
      return Response.json({ success: false, error: `Ceremony "${id}" not found` }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; }
    catch { return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 }); }

    const existing = parseYaml(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const ownershipFail = checkOwnership(caller, existing, id);
    if (ownershipFail) return ownershipFail;

    // createdBy is immutable from the body — only admins can rotate ownership
    // and only via a dedicated transfer endpoint (not built yet). Strip it.
    const { createdBy: _ignore, ...mutable } = body;
    const updated = { ...existing, ...mutable, id };
    writeFileSync(filePath, stringifyYaml(updated));

    return Response.json({ success: true, data: updated });
  }

  async function handleDeleteCeremony(req: Request, id: string): Promise<Response> {
    const caller = authenticateCaller(req);
    if (!caller) return unauthorized();

    const filePath = join(ctx.workspaceDir, "ceremonies", `${id}.yaml`);
    if (existsSync(filePath)) {
      const existing = parseYaml(readFileSync(filePath, "utf8")) as Record<string, unknown>;
      const ownershipFail = checkOwnership(caller, existing, id);
      if (ownershipFail) return ownershipFail;
      unlinkSync(filePath);
    }
    return Response.json({ success: true, message: `Ceremony "${id}" deleted` });
  }

  return [
    { method: "GET",  path: "/health",                  handler: () => Response.json({ status: "ok", timestamp: Date.now() }) },
    { method: "GET",  path: "/ready",                   handler: () => handleReady() },
    { method: "POST", path: "/publish",                 handler: (req) => handlePublish(req) },
    { method: "POST", path: "/api/onboard",             handler: (req) => handleOnboard(req) },
    { method: "GET",  path: "/api/projects",            handler: () => Response.json({ success: true, data: ctx.projectRegistry?.getProjects() ?? [] }) },
    { method: "GET",  path: "/api/agents",              handler: () => serveWorkspaceYaml(ctx.workspaceDir, "agents.yaml", "agents") },
    { method: "GET",  path: "/api/ceremonies",          handler: (req) => handleGetCeremonies(req) },
    { method: "POST", path: "/api/ceremonies/create",   handler: (req) => handleCreateCeremony(req) },
    { method: "POST", path: "/api/ceremonies/:id/run",  handler: (req, p) => handleRunCeremony(req, p.id) },
    { method: "POST", path: "/api/ceremonies/:id/update", handler: (req, p) => handleUpdateCeremony(req, p.id) },
    { method: "POST", path: "/api/ceremonies/:id/delete", handler: (req, p) => handleDeleteCeremony(req, p.id) },
    { method: "GET",  path: "/api/skills/:agentName",   handler: (_, p) => handleGetAgentSkills(p.agentName) },
    { method: "GET",  path: "/api/channels",            handler: () => Response.json({ success: true, data: [] }) },
    { method: "GET",  path: "/api/hitl/pending",        handler: () => Response.json({ success: true, data: getPendingHumanInput() }) },
  ];
}
