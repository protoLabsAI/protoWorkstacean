/**
 * Integration tests for ceremony ownership enforcement.
 *
 * Verifies:
 *   - createCeremony stamps createdBy from the caller's identity
 *   - update / delete are gated by createdBy === caller.agentName (or admin)
 *   - list filters to caller's own ceremonies (admin sees all; ?all=true is admin-only)
 *   - createdBy in update body is stripped (immutable from caller side)
 *   - admin keeps full access for backward compatibility
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { AgentKeyRegistry } from "../../../lib/auth/agent-keys.ts";
import { createRoutes } from "../operations.ts";
import type { ApiContext, Route } from "../types.ts";

const ADMIN_KEY = "admin-secret";
const QUINN_KEY = "quinn-secret";
const AVA_KEY = "ava-secret";

let workspace: string;
let routes: Route[];

function findRoute(method: string, path: string): Route {
  const r = routes.find(rt => rt.method === method && rt.path === path);
  if (!r) throw new Error(`Route ${method} ${path} not found`);
  return r;
}

function makeReq(headers: Record<string, string> = {}, body?: unknown, url = "http://x/api/ceremonies"): Request {
  return new Request(url, {
    method: body ? "POST" : "GET",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function ceremonyOnDisk(id: string): Record<string, unknown> | null {
  const p = join(workspace, "ceremonies", `${id}.yaml`);
  if (!existsSync(p)) return null;
  return parseYaml(readFileSync(p, "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ceremony-test-"));
  process.env.WORKSTACEAN_API_KEY_QUINN = QUINN_KEY;
  process.env.WORKSTACEAN_API_KEY_AVA = AVA_KEY;
  writeFileSync(
    join(workspace, "agent-keys.yaml"),
    `keys:\n  quinn:\n    envKey: WORKSTACEAN_API_KEY_QUINN\n  ava:\n    envKey: WORKSTACEAN_API_KEY_AVA\n`,
  );

  const ctx: ApiContext = {
    workspaceDir: workspace,
    bus: new InMemoryEventBus(),
    plugins: [],
    executorRegistry: new ExecutorRegistry(),
    apiKey: ADMIN_KEY,
    agentKeys: new AgentKeyRegistry(workspace, ADMIN_KEY),
  };
  routes = createRoutes(ctx);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  delete process.env.WORKSTACEAN_API_KEY_QUINN;
  delete process.env.WORKSTACEAN_API_KEY_AVA;
});

describe("ceremony ownership", () => {
  test("create stamps createdBy from agent-scoped caller", async () => {
    const create = findRoute("POST", "/api/ceremonies/create");
    const resp = await create.handler(
      makeReq(
        { "X-API-Key": QUINN_KEY, "Content-Type": "application/json" },
        { id: "quinn.daily-digest", name: "Daily QA digest", schedule: "0 14 * * *", skill: "qa_report" },
      ),
      {},
    );
    expect(resp.status).toBe(200);
    const body = await resp.json() as { success: boolean; data: Record<string, unknown> };
    expect(body.success).toBe(true);
    expect(body.data.createdBy).toBe("quinn");
    expect(ceremonyOnDisk("quinn.daily-digest")?.createdBy).toBe("quinn");
  });

  test("create by admin defaults createdBy to 'system' (or accepts override)", async () => {
    const create = findRoute("POST", "/api/ceremonies/create");
    const resp = await create.handler(
      makeReq(
        { "X-API-Key": ADMIN_KEY, "Content-Type": "application/json" },
        { id: "system.cleanup", name: "Cleanup", schedule: "0 4 * * *", skill: "cleanup", createdBy: "ava" },
      ),
      {},
    );
    expect(resp.status).toBe(200);
    const body = await resp.json() as { success: boolean; data: Record<string, unknown> };
    expect(body.data.createdBy).toBe("ava");

    // No override → defaults to system
    const resp2 = await create.handler(
      makeReq(
        { "X-API-Key": ADMIN_KEY, "Content-Type": "application/json" },
        { id: "system.bare", name: "Bare", schedule: "0 5 * * *", skill: "noop" },
      ),
      {},
    );
    expect(((await resp2.json()) as { data: { createdBy: string } }).data.createdBy).toBe("system");
  });

  test("agent cannot override createdBy on create", async () => {
    const create = findRoute("POST", "/api/ceremonies/create");
    const resp = await create.handler(
      makeReq(
        { "X-API-Key": QUINN_KEY, "Content-Type": "application/json" },
        { id: "quinn.spoof", name: "Spoof", schedule: "0 6 * * *", skill: "report", createdBy: "ava" },
      ),
      {},
    );
    expect(resp.status).toBe(200);
    const body = await resp.json() as { success: boolean; data: Record<string, unknown> };
    // createdBy from quinn's call must be "quinn", not the body's "ava" claim
    expect(body.data.createdBy).toBe("quinn");
  });

  test("update by owner succeeds", async () => {
    const create = findRoute("POST", "/api/ceremonies/create");
    await create.handler(
      makeReq(
        { "X-API-Key": QUINN_KEY, "Content-Type": "application/json" },
        { id: "quinn.task1", name: "T1", schedule: "0 9 * * *", skill: "qa_report" },
      ),
      {},
    );

    const update = findRoute("POST", "/api/ceremonies/:id/update");
    const resp = await update.handler(
      makeReq({ "X-API-Key": QUINN_KEY, "Content-Type": "application/json" }, { schedule: "0 10 * * *" }),
      { id: "quinn.task1" },
    );
    expect(resp.status).toBe(200);
    expect(ceremonyOnDisk("quinn.task1")?.schedule).toBe("0 10 * * *");
  });

  test("update by non-owner returns 403", async () => {
    const create = findRoute("POST", "/api/ceremonies/create");
    await create.handler(
      makeReq(
        { "X-API-Key": QUINN_KEY, "Content-Type": "application/json" },
        { id: "quinn.task2", name: "T2", schedule: "0 9 * * *", skill: "qa_report" },
      ),
      {},
    );

    const update = findRoute("POST", "/api/ceremonies/:id/update");
    const resp = await update.handler(
      makeReq({ "X-API-Key": AVA_KEY, "Content-Type": "application/json" }, { schedule: "0 11 * * *" }),
      { id: "quinn.task2" },
    );
    expect(resp.status).toBe(403);
    // Schedule unchanged on disk
    expect(ceremonyOnDisk("quinn.task2")?.schedule).toBe("0 9 * * *");
  });

  test("update by admin always succeeds (backward compat)", async () => {
    const create = findRoute("POST", "/api/ceremonies/create");
    await create.handler(
      makeReq(
        { "X-API-Key": QUINN_KEY, "Content-Type": "application/json" },
        { id: "quinn.task3", name: "T3", schedule: "0 9 * * *", skill: "qa_report" },
      ),
      {},
    );
    const update = findRoute("POST", "/api/ceremonies/:id/update");
    const resp = await update.handler(
      makeReq({ "X-API-Key": ADMIN_KEY, "Content-Type": "application/json" }, { schedule: "0 12 * * *" }),
      { id: "quinn.task3" },
    );
    expect(resp.status).toBe(200);
    expect(ceremonyOnDisk("quinn.task3")?.schedule).toBe("0 12 * * *");
  });

  test("update strips createdBy from body — owner can't transfer", async () => {
    const create = findRoute("POST", "/api/ceremonies/create");
    await create.handler(
      makeReq(
        { "X-API-Key": QUINN_KEY, "Content-Type": "application/json" },
        { id: "quinn.task4", name: "T4", schedule: "0 9 * * *", skill: "qa_report" },
      ),
      {},
    );
    const update = findRoute("POST", "/api/ceremonies/:id/update");
    await update.handler(
      makeReq({ "X-API-Key": QUINN_KEY, "Content-Type": "application/json" }, { createdBy: "ava", name: "renamed" }),
      { id: "quinn.task4" },
    );
    const updated = ceremonyOnDisk("quinn.task4");
    expect(updated?.createdBy).toBe("quinn"); // unchanged
    expect(updated?.name).toBe("renamed"); // other fields applied
  });

  test("delete by non-owner returns 403", async () => {
    const create = findRoute("POST", "/api/ceremonies/create");
    await create.handler(
      makeReq(
        { "X-API-Key": QUINN_KEY, "Content-Type": "application/json" },
        { id: "quinn.task5", name: "T5", schedule: "0 9 * * *", skill: "qa_report" },
      ),
      {},
    );
    const del = findRoute("POST", "/api/ceremonies/:id/delete");
    const resp = await del.handler(
      makeReq({ "X-API-Key": AVA_KEY }, undefined),
      { id: "quinn.task5" },
    );
    expect(resp.status).toBe(403);
    expect(ceremonyOnDisk("quinn.task5")).not.toBeNull();
  });

  test("list filters to caller's own; admin sees all", async () => {
    const create = findRoute("POST", "/api/ceremonies/create");
    for (const [key, id] of [[QUINN_KEY, "quinn.q1"], [QUINN_KEY, "quinn.q2"], [AVA_KEY, "ava.a1"]]) {
      await create.handler(
        makeReq({ "X-API-Key": key, "Content-Type": "application/json" }, { id, name: id, schedule: "0 1 * * *", skill: "noop" }),
        {},
      );
    }

    const list = findRoute("GET", "/api/ceremonies");

    const quinnResp = await list.handler(makeReq({ "X-API-Key": QUINN_KEY }), {});
    const quinnList = ((await quinnResp.json()) as { data: Array<{ id: string }> }).data;
    expect(quinnList.map(c => c.id).sort()).toEqual(["quinn.q1", "quinn.q2"]);

    const adminResp = await list.handler(makeReq({ "X-API-Key": ADMIN_KEY }), {});
    const adminList = ((await adminResp.json()) as { data: Array<{ id: string }> }).data;
    expect(adminList.map(c => c.id).sort()).toEqual(["ava.a1", "quinn.q1", "quinn.q2"]);
  });

  test("?all=true requires admin", async () => {
    const list = findRoute("GET", "/api/ceremonies");
    const resp = await list.handler(
      makeReq({ "X-API-Key": QUINN_KEY }, undefined, "http://x/api/ceremonies?all=true"),
      {},
    );
    expect(resp.status).toBe(401);
  });

  test("unauthenticated request returns 401", async () => {
    const list = findRoute("GET", "/api/ceremonies");
    const resp = await list.handler(makeReq({}), {});
    expect(resp.status).toBe(401);
  });
});
