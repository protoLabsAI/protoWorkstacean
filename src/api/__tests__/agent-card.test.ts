/**
 * Phase 7 — agent card endpoint exposes workstacean's registered skills.
 *
 * These tests exercise the /.well-known/agent-card.json handler directly,
 * bypassing Bun.serve. They lock down:
 *   - Skills deduplication when multiple agents register the same skill
 *   - The agent-card.json → agent.json legacy alias
 *   - WORKSTACEAN_BASE_URL is honored when building the card's url
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
  let origBaseUrl: string | undefined;

  beforeEach(() => {
    origBaseUrl = process.env.WORKSTACEAN_BASE_URL;
    process.env.WORKSTACEAN_BASE_URL = "https://workstacean.example.com";
    registry = new ExecutorRegistry();
    ctx = {
      workspaceDir: "/tmp",
      bus: new InMemoryEventBus(),
      plugins: [],
      executorRegistry: registry,
    };
  });

  afterEach(() => {
    if (origBaseUrl === undefined) delete process.env.WORKSTACEAN_BASE_URL;
    else process.env.WORKSTACEAN_BASE_URL = origBaseUrl;
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

  test("honors WORKSTACEAN_BASE_URL for the card's url", () => {
    const card = buildAgentCard(ctx);
    expect(card.url).toBe("https://workstacean.example.com/a2a");
    expect(card.preferredTransport).toBe("JSONRPC");
  });

  test("declares streaming + push notification capabilities", () => {
    const card = buildAgentCard(ctx);
    expect(card.capabilities.streaming).toBe(true);
    expect(card.capabilities.pushNotifications).toBe(true);
  });

  test("includes hitl:{mode} tag when skill has hitlMode declared", () => {
    registry.register("deploy", fakeExecutor(), { agentName: "frank", hitlMode: "gated" });
    registry.register("health_check", fakeExecutor(), { agentName: "frank", hitlMode: "autonomous" });
    registry.register("chat", fakeExecutor(), { agentName: "ava" }); // no hitlMode

    const card = buildAgentCard(ctx);

    const deploy = card.skills.find(s => s.id === "deploy");
    expect(deploy?.tags).toContain("hitl:gated");

    const health = card.skills.find(s => s.id === "health_check");
    expect(health?.tags).toContain("hitl:autonomous");

    const chat = card.skills.find(s => s.id === "chat");
    expect(chat?.tags?.some(t => t.startsWith("hitl:"))).toBe(false);
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
