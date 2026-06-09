/**
 * /api/agents/runtime host derivation (ADR-0008 WS-3a). The canvas tags A2A
 * nodes with where they live; the host comes from the declared yaml url and
 * must survive both the pending-discovery and registry-discovered paths.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import type { IExecutor, SkillRequest, SkillResult } from "../../executor/types.ts";
import { collectFleetAgents, hostFromUrl } from "../agents-runtime.ts";
import type { ApiContext } from "../types.ts";

function a2aExecutor(): IExecutor {
  return {
    type: "a2a",
    execute: async (req: SkillRequest): Promise<SkillResult> => ({ text: "", isError: false, correlationId: req.correlationId }),
  };
}
function deepAgentExecutor(): IExecutor {
  return {
    type: "deep-agent",
    execute: async (req: SkillRequest): Promise<SkillResult> => ({ text: "", isError: false, correlationId: req.correlationId }),
  };
}

describe("hostFromUrl", () => {
  test("derives host:port from an A2A url", () => {
    expect(hostFromUrl("http://roxy:7870/a2a")).toBe("roxy:7870");
  });
  test("keeps the bare host when the port is the scheme default", () => {
    expect(hostFromUrl("http://frank/a2a")).toBe("frank");
  });
  test("undefined / empty / unparseable → undefined", () => {
    expect(hostFromUrl(undefined)).toBeUndefined();
    expect(hostFromUrl("")).toBeUndefined();
    expect(hostFromUrl("roxy:7870")).toBeUndefined(); // no scheme → not a URL
  });
});

describe("collectFleetAgents host attachment", () => {
  let root: string;
  let registry: ExecutorRegistry;
  let ctx: ApiContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agents-runtime-"));
    mkdirSync(join(root, "agents.d"));
    writeFileSync(join(root, "agents.d", "roxy.yaml"), "name: roxy\nurl: http://roxy:7870/a2a\n");
    registry = new ExecutorRegistry();
    ctx = { workspaceDir: root, bus: new InMemoryEventBus(), plugins: [], executorRegistry: registry };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test("declared-but-undiscovered A2A agent carries host + pendingDiscovery", () => {
    const roxy = collectFleetAgents(ctx).find((a) => a.name === "roxy");
    expect(roxy).toBeDefined();
    expect(roxy?.type).toBe("a2a");
    expect(roxy?.host).toBe("roxy:7870");
    expect(roxy?.pendingDiscovery).toBe(true);
  });

  test("registry-discovered A2A agent keeps host, drops pendingDiscovery", () => {
    registry.register("portfolio_sitrep", a2aExecutor(), { agentName: "roxy" });
    const roxy = collectFleetAgents(ctx).find((a) => a.name === "roxy");
    expect(roxy?.host).toBe("roxy:7870");
    expect(roxy?.skills).toEqual(["portfolio_sitrep"]);
    expect(roxy?.pendingDiscovery).toBeUndefined();
  });

  test("builtin (deep-agent) agents have no host", () => {
    registry.register("pr_review", deepAgentExecutor(), { agentName: "quinn" });
    const quinn = collectFleetAgents(ctx).find((a) => a.name === "quinn");
    expect(quinn?.type).toBe("deep-agent");
    expect(quinn?.host).toBeUndefined();
  });
});
