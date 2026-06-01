/**
 * Unified control-plane read (ADR-0004 P5b) — GET /api/control-plane/state
 * returns the live fleet + the (durably-backed) health snapshot in one call.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { AgentFleetHealthPlugin } from "../../plugins/agent-fleet-health-plugin.ts";
import type { IExecutor, SkillRequest, SkillResult } from "../../executor/types.ts";
import { createRoutes } from "../control-plane.ts";
import type { ApiContext, Route } from "../types.ts";

class StubExecutor implements IExecutor {
  readonly type = "deep-agent";
  async execute(_req: SkillRequest): Promise<SkillResult> {
    return { text: "", isError: false, correlationId: "" };
  }
}

describe("GET /api/control-plane/state", () => {
  let root: string;
  let registry: ExecutorRegistry;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cp-state-"));
    registry = new ExecutorRegistry();
    registry.register("pr_review", new StubExecutor(), { agentName: "quinn" });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function ctxWith(plugins: ApiContext["plugins"]): ApiContext {
    return { workspaceDir: root, bus: new InMemoryEventBus(), plugins, executorRegistry: registry };
  }
  function route(ctx: ApiContext): Route {
    const r = createRoutes(ctx).find((x) => x.method === "GET" && x.path === "/api/control-plane/state");
    if (!r) throw new Error("route not registered");
    return r;
  }

  test("returns the fleet + health snapshot when the plugin is installed", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new AgentFleetHealthPlugin(registry);
    plugin.install(bus);
    const ctx = { ...ctxWith([plugin]), bus };

    const res = await route(ctx).handler(new Request("http://localhost/api/control-plane/state"), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { agents: Array<{ name: string }>; health: { windowHours: number } | null; collectedAt: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.agents.some((a) => a.name === "quinn")).toBe(true);
    expect(body.data.health?.windowHours).toBe(24);
    expect(body.data.collectedAt).toBeGreaterThan(0);
    plugin.uninstall();
  });

  test("health is null (not an error) when the fleet-health plugin isn't installed", async () => {
    const ctx = ctxWith([]); // no plugins
    const res = await route(ctx).handler(new Request("http://localhost/api/control-plane/state"), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { agents: unknown[]; health: null } };
    expect(body.data.health).toBeNull();
    expect(body.data.agents.length).toBeGreaterThan(0); // fleet still served from the registry
  });
});
