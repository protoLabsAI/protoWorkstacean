/**
 * Agent control-plane write API (ADR-0004 P2) — end-to-end with a real
 * InMemoryEventBus + the ControlPlaneRegistrar installed + a temp workspace.
 * POST/PUT/DELETE publish command.agent.*; the registrar (sole writer) persists
 * synchronously; the API verifies and responds.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { ControlPlaneRegistrarPlugin } from "../../plugins/control-plane-registrar-plugin.ts";
import { createRoutes } from "../agents-crud.ts";
import type { ApiContext, Route } from "../types.ts";

const AGENT = {
  name: "tester",
  role: "general",
  model: "m",
  systemPrompt: "hi",
  skills: [{ name: "chat", description: "d", keywords: [] }],
};

describe("agents-crud control-plane API", () => {
  let root: string;
  let agentsDir: string;
  let bus: InMemoryEventBus;
  let ctx: ApiContext;
  let routes: Route[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agents-crud-"));
    agentsDir = join(root, "agents");
    mkdirSync(agentsDir);
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
  function reqWith(body?: unknown, headers: Record<string, string> = {}): Request {
    return new Request("http://localhost", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  test("POST creates the agent file via the registrar (synchronous write)", async () => {
    const res = await route("POST", "/api/agents").handler(reqWith(AGENT), {});
    expect(res.status).toBe(201);
    const file = join(agentsDir, "tester.yaml");
    expect(existsSync(file)).toBe(true);
    expect((parseYaml(readFileSync(file, "utf8")) as { name: string }).name).toBe("tester");
  });

  test("POST a duplicate name → 409", async () => {
    await route("POST", "/api/agents").handler(reqWith(AGENT), {});
    const dup = await route("POST", "/api/agents").handler(reqWith(AGENT), {});
    expect(dup.status).toBe(409);
  });

  test("POST an invalid definition → 400, nothing written", async () => {
    const bad = { name: "broken", role: "general", systemPrompt: "x", skills: [] }; // missing model
    const res = await route("POST", "/api/agents").handler(reqWith(bad), {});
    expect(res.status).toBe(400);
    expect(existsSync(join(agentsDir, "broken.yaml"))).toBe(false);
  });

  test("PUT updates an existing agent; 404 when it doesn't exist", async () => {
    await route("POST", "/api/agents").handler(reqWith(AGENT), {});
    const updated = { ...AGENT, model: "m2" };
    const ok = await route("PUT", "/api/agents/:name").handler(reqWith(updated), { name: "tester" });
    expect(ok.status).toBe(200);
    expect((parseYaml(readFileSync(join(agentsDir, "tester.yaml"), "utf8")) as { model: string }).model).toBe("m2");

    const missing = await route("PUT", "/api/agents/:name").handler(reqWith({ ...AGENT, name: "ghost" }), { name: "ghost" });
    expect(missing.status).toBe(404);
  });

  test("DELETE removes the file; 404 when missing", async () => {
    await route("POST", "/api/agents").handler(reqWith(AGENT), {});
    const del = await route("DELETE", "/api/agents/:name").handler(reqWith(undefined), { name: "tester" });
    expect(del.status).toBe(200);
    expect(existsSync(join(agentsDir, "tester.yaml"))).toBe(false);

    const again = await route("DELETE", "/api/agents/:name").handler(reqWith(undefined), { name: "tester" });
    expect(again.status).toBe(404);
  });

  test("POST /api/agents/test validates without persisting", async () => {
    const ok = await route("POST", "/api/agents/test").handler(reqWith(AGENT), {});
    const body = (await ok.json()) as { valid: boolean; skills: string[] };
    expect(body.valid).toBe(true);
    expect(body.skills).toEqual(["chat"]);
    expect(existsSync(join(agentsDir, "tester.yaml"))).toBe(false);

    const bad = await route("POST", "/api/agents/test").handler(reqWith({ name: "x" }), {});
    expect(bad.status).toBe(400);
  });

  test("admin key enforced when ctx.apiKey is set", async () => {
    ctx = { ...ctx, apiKey: "secret" };
    routes = createRoutes(ctx);
    const noKey = await route("POST", "/api/agents").handler(reqWith(AGENT), {});
    expect(noKey.status).toBe(401);
    const withKey = await route("POST", "/api/agents").handler(reqWith(AGENT, { "x-api-key": "secret" }), {});
    expect(withKey.status).toBe(201);
  });

  test("registrar refuses writes outside workspace/agents (path-traversal guard)", () => {
    const outside = join(root, "escape.yaml");
    bus.publish("command.agent.upsert", {
      id: "x", correlationId: "c", topic: "command.agent.upsert", timestamp: 0,
      payload: { name: "evil", file: outside, yaml: "name: evil\n" },
    });
    expect(existsSync(outside)).toBe(false); // refused — not inside agents/
  });

  test("GET /api/agents/:name returns the full def; 404 for unknown", async () => {
    await route("POST", "/api/agents").handler(reqWith(AGENT), {});
    const res = await route("GET", "/api/agents/:name").handler(reqWith(undefined), { name: "tester" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { def: { name: string; skills: Array<{ name: string }> } };
    expect(body.def.name).toBe("tester");
    expect(body.def.skills[0]!.name).toBe("chat");

    const missing = await route("GET", "/api/agents/:name").handler(reqWith(undefined), { name: "ghost" });
    expect(missing.status).toBe(404);
  });

  test("POST /api/a2a/probe — rejects non-URL (400); unreachable host → reachable:false", async () => {
    const bad = await route("POST", "/api/a2a/probe").handler(reqWith({ url: "not-a-url" }), {});
    expect(bad.status).toBe(400);

    // 127.0.0.1:1 refuses immediately → the card fetch throws → reachable:false (no hang).
    const unreach = await route("POST", "/api/a2a/probe").handler(reqWith({ url: "http://127.0.0.1:1" }), {});
    const body = (await unreach.json()) as { reachable: boolean };
    expect(body.reachable).toBe(false);
  });

  test("A2A endpoints: create → agents.d/ file (409 dup, 400 bad-url), delete removes", async () => {
    const A2A = { name: "frank", url: "http://frank:7880/a2a", streaming: true };
    const created = await route("POST", "/api/a2a-endpoints").handler(reqWith(A2A), {});
    expect(created.status).toBe(201);
    expect(existsSync(join(root, "agents.d", "frank.yaml"))).toBe(true);

    const dup = await route("POST", "/api/a2a-endpoints").handler(reqWith(A2A), {});
    expect(dup.status).toBe(409);

    const bad = await route("POST", "/api/a2a-endpoints").handler(reqWith({ name: "x", url: "ftp://nope" }), {});
    expect(bad.status).toBe(400);

    const del = await route("DELETE", "/api/a2a-endpoints/:name").handler(reqWith(undefined), { name: "frank" });
    expect(del.status).toBe(200);
    expect(existsSync(join(root, "agents.d", "frank.yaml"))).toBe(false);

    const missing = await route("DELETE", "/api/a2a-endpoints/:name").handler(reqWith(undefined), { name: "frank" });
    expect(missing.status).toBe(404);
  });
});
