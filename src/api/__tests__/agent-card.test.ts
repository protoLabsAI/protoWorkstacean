/**
 * Phase 7 — agent card endpoint exposes workstacean's registered skills.
 *
 * These tests exercise the /.well-known/agent-card.json handler directly,
 * bypassing Bun.serve. They lock down:
 *   - Skills deduplication when multiple agents register the same skill
 *   - The agent-card.json → agent.json legacy alias
 *   - The card's `url` resolves to the actual A2A endpoint, not the dashboard:
 *       * default → http://workstacean:${HTTP_PORT}/a2a
 *       * WORKSTACEAN_PUBLIC_BASE_URL set → ${publicBase}/a2a
 *       * WORKSTACEAN_INTERNAL_HOST overrides the docker-network host
 *       * WORKSTACEAN_HTTP_PORT overrides the port
 *   - additionalInterfaces[0] mirrors the top-level url under JSONRPC
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { createRoutes, buildAgentCard } from "../agent-card.ts";
import type { ApiContext } from "../types.ts";
import type { IExecutor, SkillResult } from "../../executor/types.ts";

function fakeExecutor(type = "a2a"): IExecutor {
  return {
    type,
    async execute(): Promise<SkillResult> {
      return { text: "", isError: false, correlationId: "" };
    },
  };
}

describe("GET /.well-known/agent-card.json", () => {
  let registry: ExecutorRegistry;
  let ctx: ApiContext;
  const envKeys = [
    "WORKSTACEAN_PUBLIC_BASE_URL",
    "WORKSTACEAN_INTERNAL_HOST",
    "WORKSTACEAN_HTTP_PORT",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of envKeys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    registry = new ExecutorRegistry();
    ctx = {
      workspaceDir: "/tmp",
      bus: new InMemoryEventBus(),
      plugins: [],
      executorRegistry: registry,
    };
  });

  afterEach(() => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("emits two routes (agent-card.json + legacy agent.json)", () => {
    const routes = createRoutes(ctx);
    expect(routes).toHaveLength(2);
    expect(routes.map(r => r.path)).toEqual([
      "/.well-known/agent-card.json",
      "/.well-known/agent.json",
    ]);
    expect(routes.every(r => r.method === "GET")).toBe(true);
  });

  test("includes every registered skill with agentName as tag", () => {
    registry.register("plan", fakeExecutor(), { agentName: "ava" });
    registry.register("sitrep", fakeExecutor(), { agentName: "ava" });
    registry.register("bug_triage", fakeExecutor(), { agentName: "quinn" });

    const card = buildAgentCard(ctx);
    const skillIds = card.skills.map(s => s.id).sort();
    expect(skillIds).toEqual(["bug_triage", "plan", "sitrep"]);

    const quinnSkill = card.skills.find(s => s.id === "bug_triage");
    expect(quinnSkill?.tags).toContain("quinn");
  });

  test("dedupes skills registered by multiple agents", () => {
    registry.register("chat", fakeExecutor(), { agentName: "ava" });
    registry.register("chat", fakeExecutor(), { agentName: "quinn" });
    registry.register("chat", fakeExecutor(), { agentName: "frank" });

    const card = buildAgentCard(ctx);
    const chatSkills = card.skills.filter(s => s.id === "chat");
    expect(chatSkills).toHaveLength(1);
  });

  test("default url is the docker-network workstacean:3000/a2a — never the dashboard", () => {
    const card = buildAgentCard(ctx);
    expect(card.url).toBe("http://workstacean:3000/a2a");
    expect(card.preferredTransport).toBe("JSONRPC");
  });

  test("WORKSTACEAN_PUBLIC_BASE_URL produces the canonical public URL", () => {
    process.env.WORKSTACEAN_PUBLIC_BASE_URL = "https://ava.proto-labs.ai";
    const card = buildAgentCard(ctx);
    expect(card.url).toBe("https://ava.proto-labs.ai/a2a");
  });

  test("WORKSTACEAN_PUBLIC_BASE_URL strips a trailing slash before appending /a2a", () => {
    process.env.WORKSTACEAN_PUBLIC_BASE_URL = "https://ava.proto-labs.ai/";
    const card = buildAgentCard(ctx);
    expect(card.url).toBe("https://ava.proto-labs.ai/a2a");
  });

  test("WORKSTACEAN_INTERNAL_HOST overrides the docker-network host", () => {
    process.env.WORKSTACEAN_INTERNAL_HOST = "ava-host";
    const card = buildAgentCard(ctx);
    expect(card.url).toBe("http://ava-host:3000/a2a");
  });

  test("WORKSTACEAN_HTTP_PORT overrides the port", () => {
    process.env.WORKSTACEAN_HTTP_PORT = "4000";
    const card = buildAgentCard(ctx);
    expect(card.url).toBe("http://workstacean:4000/a2a");
  });

  test("additionalInterfaces lists the JSON-RPC transport at the same url", () => {
    process.env.WORKSTACEAN_PUBLIC_BASE_URL = "https://ava.proto-labs.ai";
    const card = buildAgentCard(ctx);
    expect(card.additionalInterfaces).toBeDefined();
    expect(card.additionalInterfaces).toHaveLength(1);
    expect(card.additionalInterfaces?.[0]?.transport).toBe("JSONRPC");
    expect(card.additionalInterfaces?.[0]?.url).toBe(card.url);
  });

  test("declares streaming + push notification capabilities", () => {
    const card = buildAgentCard(ctx);
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(true);
  });

  test("route handler returns cache-control + JSON body", async () => {
    registry.register("plan", fakeExecutor(), { agentName: "ava" });
    const [route] = createRoutes(ctx);
    const resp = route.handler(new Request("http://x/.well-known/agent-card.json"), {});
    const realResp = resp instanceof Promise ? await resp : resp;
    expect(realResp.status).toBe(200);
    expect(realResp.headers.get("cache-control")).toContain("max-age=");
    const body = await realResp.json() as { name: string; skills: Array<{ id: string }> };
    expect(body.name).toBe("workstacean");
    expect(body.skills.map(s => s.id)).toContain("plan");
  });
});
