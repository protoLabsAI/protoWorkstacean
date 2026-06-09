/**
 * Routes control-plane API (ADR-0008 P2) — POST/DELETE publish command.route.*
 * to the registrar (the sole writer); the registrar persists routes.d/; GET
 * reads it back. End-to-end with a real bus + registrar + temp workspace.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { ControlPlaneRegistrarPlugin } from "../../plugins/control-plane-registrar-plugin.ts";
import { createRoutes } from "../routes-crud.ts";
import type { ApiContext, Route } from "../types.ts";

const ROUTE = { name: "triage", when: { topic: "message.inbound.github.#" }, then: { skill: "bug_triage", agent: "quinn" } };

describe("routes-crud API", () => {
  let root: string;
  let bus: InMemoryEventBus;
  let ctx: ApiContext;
  let routes: Route[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "routes-crud-"));
    bus = new InMemoryEventBus();
    new ControlPlaneRegistrarPlugin(root).install(bus);
    ctx = { workspaceDir: root, bus, plugins: [], executorRegistry: new ExecutorRegistry() };
    routes = createRoutes(ctx);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const route = (method: string, path: string) => {
    const r = routes.find((x) => x.method === method && x.path === path);
    if (!r) throw new Error(`no route ${method} ${path}`);
    return r;
  };
  const post = (body: unknown) => new Request("http://localhost/api/routes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  test("POST creates routes.d/<name>.yaml via the registrar", async () => {
    const res = await route("POST", "/api/routes").handler(post(ROUTE), {});
    expect(res.status).toBe(201);
    const file = join(root, "routes.d", "triage.yaml");
    expect(existsSync(file)).toBe(true);
    const written = parseYaml(readFileSync(file, "utf8"));
    expect(written.name).toBe("triage");
    expect(written.then.skill).toBe("bug_triage");
  });

  test("POST an invalid route → 400 (and writes nothing)", async () => {
    const res = await route("POST", "/api/routes").handler(post({ name: "bad", then: { skill: "s" } }), {});
    expect(res.status).toBe(400);
    expect(existsSync(join(root, "routes.d", "bad.yaml"))).toBe(false);
  });

  test("GET lists persisted routes", async () => {
    await route("POST", "/api/routes").handler(post(ROUTE), {});
    const res = await route("GET", "/api/routes").handler(new Request("http://localhost/api/routes"), {});
    const body = (await res.json()) as { success: boolean; data: { routes: Array<{ name: string }> } };
    expect(body.success).toBe(true);
    expect(body.data.routes.map((r) => r.name)).toEqual(["triage"]);
  });

  test("DELETE removes the route file", async () => {
    await route("POST", "/api/routes").handler(post(ROUTE), {});
    const file = join(root, "routes.d", "triage.yaml");
    expect(existsSync(file)).toBe(true);
    const res = await route("DELETE", "/api/routes/:name").handler(new Request("http://localhost/api/routes/triage", { method: "DELETE" }), { name: "triage" });
    expect(res.status).toBe(200);
    expect(existsSync(file)).toBe(false);
  });

  test("admin key gates writes when configured", async () => {
    ctx.apiKey = "secret";
    const denied = await route("POST", "/api/routes").handler(post(ROUTE), {});
    expect(denied.status).toBe(401);
    const ok = await route("POST", "/api/routes").handler(
      new Request("http://localhost/api/routes", { method: "POST", headers: { "content-type": "application/json", "x-api-key": "secret" }, body: JSON.stringify(ROUTE) }),
      {},
    );
    expect(ok.status).toBe(201);
  });
});
