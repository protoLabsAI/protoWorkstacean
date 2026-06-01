/**
 * MCP-server control-plane write API (ADR-0005, ADR-0004 P4) — end-to-end with a
 * real InMemoryEventBus + the ControlPlaneRegistrar + a temp workspace.
 * POST/PUT/DELETE publish command.mcp.*; the registrar (sole writer) persists
 * synchronously to mcp-servers.d/<name>.yaml; the API verifies and responds.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { ControlPlaneRegistrarPlugin } from "../../plugins/control-plane-registrar-plugin.ts";
import { createRoutes, listMcpServers, mcpEnabled } from "../mcp-crud.ts";
import type { ApiContext, Route } from "../types.ts";

const STDIO = {
  name: "filesystem",
  trust: "trusted",
  transport: "stdio",
  command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/data"],
  grants: ["filesystem"],
  description: "local fs tools",
};

describe("mcp-crud control-plane API", () => {
  let root: string;
  let bus: InMemoryEventBus;
  let ctx: ApiContext;
  let routes: Route[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-crud-"));
    bus = new InMemoryEventBus();
    new ControlPlaneRegistrarPlugin(root).install(bus);
    ctx = { workspaceDir: root, bus, plugins: [], executorRegistry: new ExecutorRegistry() };
    routes = createRoutes(ctx);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function route(method: string, path: string): Route {
    const r = routes.find((x) => x.method === method && x.path === path);
    if (!r) throw new Error(`no route ${method} ${path}`);
    return r;
  }
  function req(body?: unknown): Request {
    return new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  test("POST creates mcp-servers.d/<name>.yaml via the registrar (synchronous write)", async () => {
    const res = await route("POST", "/api/mcp-servers").handler(req(STDIO), {});
    expect(res.status).toBe(201);
    const file = join(root, "mcp-servers.d", "filesystem.yaml");
    expect(existsSync(file)).toBe(true);
    expect((parseYaml(readFileSync(file, "utf8")) as { name: string }).name).toBe("filesystem");
  });

  test("POST a duplicate → 409", async () => {
    await route("POST", "/api/mcp-servers").handler(req(STDIO), {});
    const dup = await route("POST", "/api/mcp-servers").handler(req(STDIO), {});
    expect(dup.status).toBe(409);
  });

  test("validation: stdio needs a command; sse needs an http url; bad trust/grant → 400", async () => {
    const noCmd = await route("POST", "/api/mcp-servers").handler(req({ name: "x", transport: "stdio" }), {});
    expect(noCmd.status).toBe(400);
    const badSse = await route("POST", "/api/mcp-servers").handler(req({ name: "y", transport: "sse", url: "ftp://nope" }), {});
    expect(badSse.status).toBe(400);
    const badTrust = await route("POST", "/api/mcp-servers").handler(req({ ...STDIO, name: "z", trust: "wizard" }), {});
    expect(badTrust.status).toBe(400);
    const badGrant = await route("POST", "/api/mcp-servers").handler(req({ ...STDIO, name: "g", grants: ["root"] }), {});
    expect(badGrant.status).toBe(400);
    // none persisted
    expect(listMcpServers(root)).toHaveLength(0);
  });

  test("PUT updates an existing server; 404 when missing", async () => {
    await route("POST", "/api/mcp-servers").handler(req(STDIO), {});
    const ok = await route("PUT", "/api/mcp-servers/:name").handler(
      req({ ...STDIO, description: "updated" }), { name: "filesystem" },
    );
    expect(ok.status).toBe(200);
    expect(listMcpServers(root)[0]!.description).toBe("updated");

    const missing = await route("PUT", "/api/mcp-servers/:name").handler(req({ ...STDIO, name: "ghost" }), { name: "ghost" });
    expect(missing.status).toBe(404);
  });

  test("DELETE removes the file; 404 when missing", async () => {
    await route("POST", "/api/mcp-servers").handler(req(STDIO), {});
    const del = await route("DELETE", "/api/mcp-servers/:name").handler(req(undefined), { name: "filesystem" });
    expect(del.status).toBe(200);
    expect(existsSync(join(root, "mcp-servers.d", "filesystem.yaml"))).toBe(false);
    const again = await route("DELETE", "/api/mcp-servers/:name").handler(req(undefined), { name: "filesystem" });
    expect(again.status).toBe(404);
  });

  test("GET lists registered servers with effective enabled + trust", async () => {
    await route("POST", "/api/mcp-servers").handler(req(STDIO), {}); // trusted → auto-enabled
    await route("POST", "/api/mcp-servers").handler(req({ name: "thirdparty", transport: "sse", url: "https://x/mcp" }), {}); // community → off
    const res = await route("GET", "/api/mcp-servers").handler(req(undefined), {});
    const body = (await res.json()) as { data: { servers: Array<{ name: string; enabled: boolean; trust: string }> } };
    const byName = Object.fromEntries(body.data.servers.map((s) => [s.name, s]));
    expect(byName.filesystem!.enabled).toBe(true);
    expect(byName.thirdparty!.trust).toBe("community");
    expect(byName.thirdparty!.enabled).toBe(false); // community is off until the operator enables it (ADR-0005 D2)
  });

  test("admin key enforced when ctx.apiKey is set", async () => {
    ctx = { ...ctx, apiKey: "secret" };
    routes = createRoutes(ctx);
    const noKey = await route("POST", "/api/mcp-servers").handler(req(STDIO), {});
    expect(noKey.status).toBe(401);
  });
});

describe("mcpEnabled — trust-tier auto-enable (ADR-0005 D2)", () => {
  test("explicit enabled wins", () => {
    expect(mcpEnabled({ trust: "community", enabled: true })).toBe(true);
    expect(mcpEnabled({ trust: "builtin", enabled: false })).toBe(false);
  });
  test("builtin / trusted auto-enable; community off by default", () => {
    expect(mcpEnabled({ trust: "builtin" })).toBe(true);
    expect(mcpEnabled({ trust: "trusted" })).toBe(true);
    expect(mcpEnabled({ trust: "community" })).toBe(false);
    expect(mcpEnabled({})).toBe(false); // default trust is community
  });
});
