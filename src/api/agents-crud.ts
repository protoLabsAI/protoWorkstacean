/**
 * Agent control-plane write API (ADR-0004 P2).
 *
 *   POST   /api/agents          — create an in-process (DeepAgent) agent
 *   PUT    /api/agents/:name     — update an existing agent
 *   DELETE /api/agents/:name     — remove an agent
 *   POST   /api/agents/test      — validate a definition without persisting
 *
 * Each mutation validates the definition (the same `parseAgentYaml` the loader
 * uses → 400 on a bad def), resolves the target file, and publishes a
 * `command.agent.*` topic. The ControlPlaneRegistrar is the sole writer; the
 * file write triggers the agent-runtime hot-reload (P1), so the change is live
 * within ~5s — no restart. Admin-key gated.
 *
 * Reads stay on `GET /api/agents/runtime` (the live registry view).
 */

import { join, resolve, dirname } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import type { Route, ApiContext } from "./types.ts";
import { parseAgentYaml, loadAgentEntries } from "../agent-runtime/agent-definition-loader.ts";
import type { AgentDefinition, RawAgentYaml } from "../agent-runtime/types.ts";

function safeFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
}

export function createRoutes(ctx: ApiContext): Route[] {
  const agentsDir = join(ctx.workspaceDir, "agents");

  const authorized = (req: Request): boolean => {
    if (!ctx.apiKey) return true;
    if (req.headers.get("x-api-key") === ctx.apiKey) return true;
    return req.headers.get("authorization") === `Bearer ${ctx.apiKey}`;
  };
  const unauthorized = () => Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const badJson = () => Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });

  /** Validate a raw agent body → the parsed def, or a 400 Response. */
  function validate(body: unknown): { def: AgentDefinition } | { error: Response } {
    try {
      return { def: parseAgentYaml(body as RawAgentYaml, "(request body)") };
    } catch (err) {
      return { error: Response.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 400 }) };
    }
  }

  /** The source file of a currently-defined agent, by name (one file per agent). */
  function fileForAgent(name: string): string | undefined {
    return loadAgentEntries(ctx.workspaceDir).find((e) => e.def.name === name)?.file;
  }

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

  // ── A2A endpoints (control-plane-managed, per-file in workspace/agents.d/) ──
  const agentsdDir = join(ctx.workspaceDir, "agents.d");
  /** The managed file for an A2A agent (control-plane writes here; agents.yaml stays hand-maintained). */
  const a2aManagedFile = (name: string) => join(agentsdDir, `${safeFileName(name)}.yaml`);
  /** All A2A agent names known today — agents.yaml (hand-maintained) + agents.d/ (managed). */
  function listA2aNames(): string[] {
    const names: string[] = [];
    const yamlPath = join(ctx.workspaceDir, "agents.yaml");
    if (existsSync(yamlPath)) {
      try {
        const p = parseYaml(readFileSync(yamlPath, "utf8")) as { agents?: Array<{ name?: string }> };
        for (const a of p?.agents ?? []) if (a?.name) names.push(a.name);
      } catch { /* tolerate a malformed agents.yaml */ }
    }
    if (existsSync(agentsdDir)) {
      try {
        for (const f of readdirSync(agentsdDir)) {
          if (!/\.ya?ml$/.test(f) || f.endsWith(".example")) continue;
          try {
            const d = parseYaml(readFileSync(join(agentsdDir, f), "utf8")) as { name?: string };
            if (d?.name) names.push(d.name);
          } catch { /* skip */ }
        }
      } catch { /* dir gone */ }
    }
    return names;
  }
  /** Validate an A2A entry — name + http(s) url are the essentials SkillBroker needs. */
  function validateA2a(body: unknown): { entry: Record<string, unknown> } | { error: Response } {
    const e = (body ?? {}) as Record<string, unknown>;
    if (!e.name || typeof e.name !== "string") {
      return { error: Response.json({ success: false, error: "name (string) is required" }, { status: 400 }) };
    }
    if (!e.url || typeof e.url !== "string" || !/^https?:\/\//.test(e.url)) {
      return { error: Response.json({ success: false, error: "url (http/https) is required" }, { status: 400 }) };
    }
    return { entry: e };
  }

  return [
    {
      // Capability discovery (ADR-0004 P3): probe an A2A agent's card for
      // reachability + skills, so the operator picks from real capabilities
      // instead of a free-text guess. Admin-gated; 5s timeout; tries the
      // canonical agent-card.json then the legacy agent.json.
      method: "POST",
      path: "/api/a2a/probe",
      handler: async (req) => {
        if (!authorized(req)) return unauthorized();
        let body: { url?: string };
        try { body = (await req.json()) as { url?: string }; } catch { return badJson(); }
        const raw = (body.url ?? "").trim();
        if (!/^https?:\/\//.test(raw)) {
          return Response.json({ success: false, error: "url must be an http(s) URL" }, { status: 400 });
        }
        const base = raw.replace(/\/+$/, "");
        for (const cardUrl of [`${base}/.well-known/agent-card.json`, `${base}/.well-known/agent.json`]) {
          try {
            const res = await fetch(cardUrl, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) continue;
            const card = (await res.json()) as {
              name?: string;
              description?: string;
              skills?: Array<{ id?: string; name?: string; description?: string }>;
            };
            const skills = (card.skills ?? [])
              .map((s) => s.id ?? s.name ?? "")
              .filter((s): s is string => Boolean(s));
            return Response.json({
              success: true, reachable: true, cardUrl,
              name: card.name ?? base, description: card.description ?? "", skills,
            });
          } catch {
            // try the next candidate
          }
        }
        return Response.json({ success: true, reachable: false, error: `No agent card at ${base}/.well-known/agent-card.json` });
      },
    },
    {
      // Read one agent's full definition (for the Console's edit form). The
      // earlier-registered GET /api/agents/runtime wins for the literal
      // "runtime", so this only sees real agent names.
      method: "GET",
      path: "/api/agents/:name",
      handler: async (req, p) => {
        if (!authorized(req)) return unauthorized();
        const file = fileForAgent(p.name);
        if (!file) return Response.json({ success: false, error: `Agent "${p.name}" not found` }, { status: 404 });
        try {
          const def = parseYaml(readFileSync(file, "utf8"));
          return Response.json({ success: true, name: p.name, file, def });
        } catch (err) {
          return Response.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
        }
      },
    },
    {
      method: "POST",
      path: "/api/agents/test",
      handler: async (req) => {
        if (!authorized(req)) return unauthorized();
        let body: unknown;
        try { body = await req.json(); } catch { return badJson(); }
        const v = validate(body);
        if ("error" in v) return v.error;
        return Response.json({
          success: true,
          valid: true,
          name: v.def.name,
          role: v.def.role,
          model: v.def.model,
          skills: v.def.skills.map((s) => s.name),
        });
      },
    },
    {
      method: "POST",
      path: "/api/agents",
      handler: async (req) => {
        if (!authorized(req)) return unauthorized();
        let body: unknown;
        try { body = await req.json(); } catch { return badJson(); }
        const v = validate(body);
        if ("error" in v) return v.error;
        const name = v.def.name;
        if (fileForAgent(name)) {
          return Response.json(
            { success: false, error: `Agent "${name}" already exists — use PUT /api/agents/${name} to update` },
            { status: 409 },
          );
        }
        const safe = safeFileName(name);
        if (!safe) return Response.json({ success: false, error: "agent name has no usable filename characters" }, { status: 400 });
        const file = resolve(join(agentsDir, `${safe}.yaml`));
        if (dirname(file) !== resolve(agentsDir)) {
          return Response.json({ success: false, error: "invalid agent name" }, { status: 400 });
        }
        command("command.agent.upsert", name, { file, yaml: stringifyYaml(body) });
        // Bus dispatch is synchronous → the registrar already wrote the file.
        if (!existsSync(file)) {
          return Response.json({ success: false, error: "write did not complete (see logs)" }, { status: 500 });
        }
        return Response.json({ success: true, name, file, note: "registered within ~5s via hot-reload" }, { status: 201 });
      },
    },
    {
      method: "PUT",
      path: "/api/agents/:name",
      handler: async (req, p) => {
        if (!authorized(req)) return unauthorized();
        let body: unknown;
        try { body = await req.json(); } catch { return badJson(); }
        const v = validate(body);
        if ("error" in v) return v.error;
        if (v.def.name !== p.name) {
          return Response.json({ success: false, error: `body name "${v.def.name}" must match path "${p.name}"` }, { status: 400 });
        }
        const file = fileForAgent(p.name);
        if (!file) return Response.json({ success: false, error: `Agent "${p.name}" not found` }, { status: 404 });
        command("command.agent.upsert", p.name, { file, yaml: stringifyYaml(body) });
        return Response.json({ success: true, name: p.name, file, note: "reloaded within ~5s" });
      },
    },
    {
      method: "DELETE",
      path: "/api/agents/:name",
      handler: async (req, p) => {
        if (!authorized(req)) return unauthorized();
        const file = fileForAgent(p.name);
        if (!file) return Response.json({ success: false, error: `Agent "${p.name}" not found` }, { status: 404 });
        command("command.agent.remove", p.name, { file });
        if (existsSync(file)) {
          return Response.json({ success: false, error: "delete did not complete (see logs)" }, { status: 500 });
        }
        return Response.json({ success: true, name: p.name, note: "unregistered within ~5s" });
      },
    },

    // ── A2A endpoints — control-plane-managed remote agents (agents.d/) ──
    {
      method: "POST",
      path: "/api/a2a-endpoints",
      handler: async (req) => {
        if (!authorized(req)) return unauthorized();
        let body: unknown;
        try { body = await req.json(); } catch { return badJson(); }
        const v = validateA2a(body);
        if ("error" in v) return v.error;
        const name = v.entry.name as string;
        if (listA2aNames().includes(name)) {
          return Response.json({ success: false, error: `A2A agent "${name}" already exists` }, { status: 409 });
        }
        const file = a2aManagedFile(name);
        command("command.a2a.upsert", name, { file, yaml: stringifyYaml(v.entry), entry: v.entry });
        if (!existsSync(file)) {
          return Response.json({ success: false, error: "write did not complete (see logs)" }, { status: 500 });
        }
        return Response.json({ success: true, name, file, note: "registered live (SkillBroker)" }, { status: 201 });
      },
    },
    {
      method: "PUT",
      path: "/api/a2a-endpoints/:name",
      handler: async (req, p) => {
        if (!authorized(req)) return unauthorized();
        let body: unknown;
        try { body = await req.json(); } catch { return badJson(); }
        const v = validateA2a(body);
        if ("error" in v) return v.error;
        if (v.entry.name !== p.name) {
          return Response.json({ success: false, error: `body name "${v.entry.name as string}" must match path "${p.name}"` }, { status: 400 });
        }
        const file = a2aManagedFile(p.name);
        if (!existsSync(file)) {
          return Response.json({ success: false, error: `A2A agent "${p.name}" not found (control-plane managed only — hand-maintained agents.yaml entries are edited there)` }, { status: 404 });
        }
        command("command.a2a.upsert", p.name, { file, yaml: stringifyYaml(v.entry), entry: v.entry });
        return Response.json({ success: true, name: p.name, file, note: "updated live" });
      },
    },
    {
      method: "DELETE",
      path: "/api/a2a-endpoints/:name",
      handler: async (req, p) => {
        if (!authorized(req)) return unauthorized();
        const file = a2aManagedFile(p.name);
        if (!existsSync(file)) {
          return Response.json({ success: false, error: `A2A agent "${p.name}" not found (control-plane managed only)` }, { status: 404 });
        }
        command("command.a2a.remove", p.name, { file });
        if (existsSync(file)) {
          return Response.json({ success: false, error: "delete did not complete (see logs)" }, { status: 500 });
        }
        return Response.json({ success: true, name: p.name, note: "unregistered live" });
      },
    },
  ];
}
