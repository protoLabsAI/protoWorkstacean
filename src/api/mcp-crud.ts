/**
 * MCP-server control-plane write API (ADR-0005, ADR-0004 P4).
 *
 *   GET    /api/mcp-servers        — list registered MCP servers (registry view)
 *   POST   /api/mcp-servers        — register a server
 *   PUT    /api/mcp-servers/:name  — update a server
 *   DELETE /api/mcp-servers/:name  — remove a server
 *
 * Mirrors the A2A-endpoints flow in agents-crud.ts exactly: validate → publish
 * `command.mcp.*` → the sole ControlPlaneRegistrar performs the atomic write to
 * workspace/mcp-servers.d/<name>.yaml → McpClientPlugin reconciles live (the
 * live connection + tool registration lands in P4 day-3). Admin-key gated.
 *
 * Capability discovery (POST /api/mcp-servers/test) arrives with the client in
 * day-3 — it needs the MCP connection to list tools.
 */

import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import type { Route, ApiContext } from "./types.ts";
import type { McpServerDef, TrustTier, McpTransport, CapabilityGrant } from "../mcp/types.ts";
import { mcpEnabled, probeMcpServer } from "../mcp/mcp-connect.ts";

// Canonical trust-tier enable gate lives in mcp-connect (shared with the plugin);
// re-exported so existing importers (and the unified read) keep their path.
export { mcpEnabled };

const TRUST_TIERS: TrustTier[] = ["builtin", "trusted", "community"];
const TRANSPORTS: McpTransport[] = ["stdio", "sse"];
const GRANTS: CapabilityGrant[] = ["network", "secrets", "filesystem"];

function safeFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
}

/** Summary of a registered MCP server (registry state; live tools come from the executor registry). */
export interface McpServerSummary {
  name: string;
  trust: TrustTier;
  transport: McpTransport;
  enabled: boolean;
  grants: CapabilityGrant[];
  description?: string;
}

/** Every MCP server registered on disk (workspace/mcp-servers.d/*.yaml). Shared with the unified read. */
export function listMcpServers(workspaceDir: string): McpServerSummary[] {
  const dir = join(workspaceDir, "mcp-servers.d");
  if (!existsSync(dir)) return [];
  const out: McpServerSummary[] = [];
  for (const f of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(f) || f.endsWith(".example")) continue;
    try {
      const d = parseYaml(readFileSync(join(dir, f), "utf8")) as McpServerDef;
      if (!d?.name) continue;
      out.push({
        name: d.name,
        trust: d.trust ?? "community",
        transport: d.transport ?? "stdio",
        enabled: mcpEnabled(d),
        grants: Array.isArray(d.grants) ? d.grants : [],
        description: d.description,
      });
    } catch {
      // skip an unparseable managed file
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function createRoutes(ctx: ApiContext): Route[] {
  const mcpDir = join(ctx.workspaceDir, "mcp-servers.d");
  const managedFile = (name: string) => join(mcpDir, `${safeFileName(name)}.yaml`);

  const authorized = (req: Request): boolean => {
    if (!ctx.apiKey) return true;
    if (req.headers.get("x-api-key") === ctx.apiKey) return true;
    return req.headers.get("authorization") === `Bearer ${ctx.apiKey}`;
  };
  const unauthorized = () => Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
  const badJson = () => Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });

  /** Validate an MCP server def: name + trust/transport enums + transport-specific fields + grant enums. */
  function validate(body: unknown): { def: McpServerDef } | { error: Response } {
    const e = (body ?? {}) as Record<string, unknown>;
    const fail = (msg: string) => ({ error: Response.json({ success: false, error: msg }, { status: 400 }) });

    if (!e.name || typeof e.name !== "string") return fail("name (string) is required");
    if (e.trust !== undefined && !TRUST_TIERS.includes(e.trust as TrustTier)) {
      return fail(`trust must be one of ${TRUST_TIERS.join(" | ")}`);
    }
    const transport = (e.transport as McpTransport | undefined) ?? "stdio";
    if (!TRANSPORTS.includes(transport)) return fail(`transport must be one of ${TRANSPORTS.join(" | ")}`);
    if (transport === "stdio") {
      const hasCmd = Array.isArray(e.command) && e.command.length > 0;
      const hasArgs = Array.isArray(e.args) && e.args.length > 0;
      if (!hasCmd && !hasArgs) return fail("stdio transport requires a non-empty command (or args)");
    } else if (transport === "sse") {
      if (!e.url || typeof e.url !== "string" || !/^https?:\/\//.test(e.url)) {
        return fail("sse transport requires url (http/https)");
      }
    }
    if (e.grants !== undefined) {
      if (!Array.isArray(e.grants) || !e.grants.every((g) => GRANTS.includes(g as CapabilityGrant))) {
        return fail(`grants must be an array of ${GRANTS.join(" | ")}`);
      }
    }
    return { def: e as unknown as McpServerDef };
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

  const knownNames = () => new Set(listMcpServers(ctx.workspaceDir).map((s) => s.name));

  return [
    {
      // Capability discovery (ADR-0005): connect to a candidate MCP server and
      // list its tools, so the operator sees real capabilities before saving —
      // the test-before-save mirror of /api/a2a/probe. Validates the def first.
      method: "POST",
      path: "/api/mcp-servers/test",
      handler: async (req) => {
        if (!authorized(req)) return unauthorized();
        let body: unknown;
        try { body = await req.json(); } catch { return badJson(); }
        const v = validate(body);
        if ("error" in v) return v.error;
        const probe = await probeMcpServer(v.def);
        return Response.json({ success: true, ...probe });
      },
    },
    {
      method: "GET",
      path: "/api/mcp-servers",
      handler: (req) => {
        if (!authorized(req)) return unauthorized();
        return Response.json({ success: true, data: { servers: listMcpServers(ctx.workspaceDir) } });
      },
    },
    {
      // Full stored def for one server (to pre-fill the edit form / flip enabled).
      // env holds unresolved ${VAR} refs (resolved at connect time), not secrets.
      method: "GET",
      path: "/api/mcp-servers/:name",
      handler: (req, p) => {
        if (!authorized(req)) return unauthorized();
        const file = managedFile(p.name);
        if (!existsSync(file)) {
          return Response.json({ success: false, error: `MCP server "${p.name}" not found` }, { status: 404 });
        }
        try {
          const def = parseYaml(readFileSync(file, "utf8"));
          return Response.json({ success: true, name: p.name, def });
        } catch (err) {
          return Response.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
        }
      },
    },
    {
      method: "POST",
      path: "/api/mcp-servers",
      handler: async (req) => {
        if (!authorized(req)) return unauthorized();
        let body: unknown;
        try { body = await req.json(); } catch { return badJson(); }
        const v = validate(body);
        if ("error" in v) return v.error;
        const name = v.def.name;
        if (knownNames().has(name)) {
          return Response.json({ success: false, error: `MCP server "${name}" already exists` }, { status: 409 });
        }
        const safe = safeFileName(name);
        if (!safe) return Response.json({ success: false, error: "server name has no usable filename characters" }, { status: 400 });
        const file = managedFile(name);
        command("command.mcp.upsert", name, { file, yaml: stringifyYaml(v.def), entry: v.def });
        if (!existsSync(file)) {
          return Response.json({ success: false, error: "write did not complete (see logs)" }, { status: 500 });
        }
        return Response.json(
          { success: true, name, file, enabled: mcpEnabled(v.def), note: "registered (tools connect live once enabled)" },
          { status: 201 },
        );
      },
    },
    {
      method: "PUT",
      path: "/api/mcp-servers/:name",
      handler: async (req, p) => {
        if (!authorized(req)) return unauthorized();
        let body: unknown;
        try { body = await req.json(); } catch { return badJson(); }
        const v = validate(body);
        if ("error" in v) return v.error;
        if (v.def.name !== p.name) {
          return Response.json({ success: false, error: `body name "${v.def.name}" must match path "${p.name}"` }, { status: 400 });
        }
        const file = managedFile(p.name);
        if (!existsSync(file)) {
          return Response.json({ success: false, error: `MCP server "${p.name}" not found` }, { status: 404 });
        }
        command("command.mcp.upsert", p.name, { file, yaml: stringifyYaml(v.def), entry: v.def });
        return Response.json({ success: true, name: p.name, file, enabled: mcpEnabled(v.def), note: "updated live" });
      },
    },
    {
      method: "DELETE",
      path: "/api/mcp-servers/:name",
      handler: async (req, p) => {
        if (!authorized(req)) return unauthorized();
        const file = managedFile(p.name);
        if (!existsSync(file)) {
          return Response.json({ success: false, error: `MCP server "${p.name}" not found` }, { status: 404 });
        }
        command("command.mcp.remove", p.name, { file });
        if (existsSync(file)) {
          return Response.json({ success: false, error: "delete did not complete (see logs)" }, { status: 500 });
        }
        return Response.json({ success: true, name: p.name, note: "unregistered live" });
      },
    },
  ];
}
