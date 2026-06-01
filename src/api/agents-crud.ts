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
import { existsSync, readFileSync } from "node:fs";
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

  return [
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
  ];
}
