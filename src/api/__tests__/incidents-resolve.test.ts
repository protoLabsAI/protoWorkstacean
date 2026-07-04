/**
 * POST /api/incidents/:id/resolve — marks an incident resolved and records an
 * audit trail (resolvedAt + optional note). Backs Ava's daily-digest
 * self-clear of stale tooling incidents (INC-019). A bare POST (no body) still
 * resolves; a `{ note }` body is recorded.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { createRoutes } from "../incidents.ts";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import type { ApiContext } from "../types.ts";

let dir: string;

function ctx(): ApiContext {
  return { bus: new InMemoryEventBus(), workspaceDir: dir } as unknown as ApiContext;
}
function resolveHandler() {
  const r = createRoutes(ctx()).find((r) => r.path === "/api/incidents/:id/resolve" && r.method === "POST");
  if (!r) throw new Error("resolve route not found");
  return r.handler;
}
function post(id: string, body?: unknown): Request {
  return new Request(`http://local/api/incidents/${id}/resolve`, {
    method: "POST",
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });
}
function seed(incidents: unknown[]): void {
  writeFileSync(join(dir, "incidents.yaml"), `incidents:\n${incidents.map((i) => `  - ${JSON.stringify(i)}`).join("\n")}\n`);
}
function readIncidents(): Array<Record<string, unknown>> {
  return (parseYaml(readFileSync(join(dir, "incidents.yaml"), "utf8")) as { incidents: Array<Record<string, unknown>> }).incidents;
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "inc-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("POST /api/incidents/:id/resolve", () => {
  test("with a note → status resolved + resolvedAt + resolutionNote", async () => {
    seed([{ id: "INC-019", title: "APIs degraded", severity: "high", status: "open", reportedAt: "2026-06-27T18:00:00Z" }]);
    const res = await resolveHandler()(post("INC-019", { note: "get_ci_health returned normally in today's digest" }), { id: "INC-019" });
    expect(res.status).toBe(200);
    const inc = readIncidents().find((i) => i.id === "INC-019")!;
    expect(inc.status).toBe("resolved");
    expect(typeof inc.resolvedAt).toBe("string");
    expect(inc.resolutionNote).toContain("get_ci_health");
  });

  test("bare POST (no body) still resolves, no note", async () => {
    seed([{ id: "INC-019", title: "x", severity: "low", status: "open", reportedAt: "2026-06-27T18:00:00Z" }]);
    const res = await resolveHandler()(post("INC-019"), { id: "INC-019" });
    expect(res.status).toBe(200);
    const inc = readIncidents().find((i) => i.id === "INC-019")!;
    expect(inc.status).toBe("resolved");
    expect(inc.resolvedAt).toBeDefined();
    expect(inc.resolutionNote).toBeUndefined();
  });

  test("unknown id → 404, file untouched", async () => {
    seed([{ id: "INC-001", title: "x", severity: "low", status: "open", reportedAt: "2026-06-27T18:00:00Z" }]);
    const res = await resolveHandler()(post("INC-999"), { id: "INC-999" });
    expect(res.status).toBe(404);
    expect(readIncidents()[0]!.status).toBe("open");
  });
});
