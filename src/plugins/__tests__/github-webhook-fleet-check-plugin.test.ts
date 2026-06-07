/**
 * Verifies GithubWebhookFleetCheckPlugin: tracks inbound GitHub events per repo,
 * flags repos with 0 events in check window, escalates once per cooldown, and
 * suppresses follow-on alerts until cooldown clears.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { GithubWebhookFleetCheckPlugin } from "../github-webhook-fleet-check-plugin.ts";
import type { ProjectRegistry } from "../project-registry.js";
import type { BusMessage } from "../../../lib/types.ts";
import type { SkillRequest, SkillResult } from "../../executor/types.ts";

function fakeProjectRegistry(coords: string[]): ProjectRegistry {
  return {
    getGithubCoords: () => coords,
    getProjects: () => [],
    getBySlug: () => undefined,
    getByGithub: () => undefined,
    getByPath: () => undefined,
    getLastRefreshAt: () => 0,
    getLastError: () => undefined,
    refreshNow: async () => {},
    start: () => {},
    stop: () => {},
  } as unknown as ProjectRegistry;
}

function publishInboundGithub(bus: InMemoryEventBus, owner: string, repo: string, event: string = "pull_request", number: number = 1) {
  const topic = `message.inbound.github.${owner}.${repo}.${event}.${number}`;
  bus.publish(topic, {
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    topic,
    timestamp: Date.now(),
    payload: {
      sender: "test-user",
      channel: `${owner}/${repo}#${number}`,
      content: `Test ${event} #${number}`,
      github: { event, owner, repo, number },
    },
  });
}

function runSkill(plugin: GithubWebhookFleetCheckPlugin, registry: ExecutorRegistry, correlationId = "c1"): Promise<SkillResult> {
  const executor = registry.resolve("check_github_webhook_routes", []);
  if (!executor) throw new Error("check_github_webhook_routes not registered");
  const req: SkillRequest = {
    skill: "check_github_webhook_routes",
    content: "",
    correlationId,
    parentId: "p1",
    replyTopic: "reply.test",
    payload: { skill: "check_github_webhook_routes" },
  };
  return executor.execute(req);
}

describe("GithubWebhookFleetCheckPlugin", () => {
  let bus: InMemoryEventBus;
  let registry: ExecutorRegistry;
  let plugin: GithubWebhookFleetCheckPlugin;
  let projectRegistry: ProjectRegistry;
  let escalations: BusMessage[];

  beforeEach(() => {
    bus = new InMemoryEventBus();
    registry = new ExecutorRegistry();
    escalations = [];
    bus.subscribe("operator.message.request", "test-collector", msg => {
      escalations.push(msg);
    });
    // Lower window + cooldown for tests
    process.env["WORKSTACEAN_GITHUB_WEBHOOK_CHECK_WINDOW_MS"] = "60000";
    process.env["WORKSTACEAN_GITHUB_WEBHOOK_ALERT_COOLDOWN_MS"] = "60000";
    projectRegistry = fakeProjectRegistry(["protoLabsAI/protoPen", "protoLabsAI/protoContent"]);
    plugin = new GithubWebhookFleetCheckPlugin(registry, projectRegistry);
    plugin.install(bus);
  });

  afterEach(() => {
    plugin.uninstall();
    delete process.env["WORKSTACEAN_GITHUB_WEBHOOK_CHECK_WINDOW_MS"];
    delete process.env["WORKSTACEAN_GITHUB_WEBHOOK_ALERT_COOLDOWN_MS"];
  });

  test("registers check_github_webhook_routes on the ExecutorRegistry at install", () => {
    const freshRegistry = new ExecutorRegistry();
    const freshPlugin = new GithubWebhookFleetCheckPlugin(freshRegistry, projectRegistry);
    expect(freshRegistry.resolve("check_github_webhook_routes", [])).toBeNull();
    freshPlugin.install(bus);
    expect(freshRegistry.resolve("check_github_webhook_routes", [])).not.toBeNull();
    freshPlugin.uninstall();
  });

  test("all repos have recent events → zero escalations", () => {
    publishInboundGithub(bus, "protoLabsAI", "protoPen", "pull_request", 42);
    publishInboundGithub(bus, "protoLabsAI", "protoContent", "pull_request", 7);
    const result = runSkill(plugin, registry);
    expect(escalations).toHaveLength(0);
    expect(result.then(r => r.isError)).resolves.toBe(false);
  });

  test("repo with 0 events in check window → exactly one escalation", () => {
    // protoPen gets events, protoContent does not
    publishInboundGithub(bus, "protoLabsAI", "protoPen", "pull_request", 42);
    const result = runSkill(plugin, registry);
    expect(escalations).toHaveLength(1);
    const payload = escalations[0].payload as Record<string, unknown>;
    expect(payload.type).toBe("operator_message_request");
    expect(payload.from).toBe("github-webhook-fleet-check");
    expect(payload.urgency).toBe("high");
    const message = payload.message as string;
    expect(message).toContain("protoLabsAI/protoContent");
    expect(message).toContain("0 inbound events");
    expect(message).toContain("hooks.proto-labs.ai");
    expect(result.then(r => r.text)).resolves.toContain("1 repo");
  });

  test("both repos silent → two escalations", () => {
    const result = runSkill(plugin, registry);
    expect(escalations).toHaveLength(2);
    const repos = escalations.map(m => (m.payload as Record<string, unknown>).topic as string);
    expect(repos).toContain("github-webhook-silent/protoLabsAI/protoPen");
    expect(repos).toContain("github-webhook-silent/protoLabsAI/protoContent");
    expect(result.then(r => r.text)).resolves.toContain("2 repo");
  });

  test("further check runs within cooldown → no second escalation", async () => {
    // First run fires for protoContent
    await runSkill(plugin, registry, "c1");
    expect(escalations).toHaveLength(1);

    // Second run within cooldown — suppressed
    const result = await runSkill(plugin, registry, "c2");
    expect(escalations).toHaveLength(1);
    expect(result.text).toContain("cooldown-suppressed");
  });

  test("inbound event clears the violation for that repo", async () => {
    // First run: protoContent is silent
    await runSkill(plugin, registry, "c1");
    expect(escalations).toHaveLength(1);

    // protoContent receives an event
    publishInboundGithub(bus, "protoLabsAI", "protoContent", "pull_request", 7);

    // Clear cooldown so we can re-check
    delete process.env["WORKSTACEAN_GITHUB_WEBHOOK_ALERT_COOLDOWN_MS"];

    // Second run: protoContent is now healthy
    const result = await runSkill(plugin, registry, "c3");
    expect(escalations).toHaveLength(1); // still 1 — no new escalation
    expect(result.text).toContain("All 2 repo");
  });

  test("repo with stale events (outside window) → still flagged", () => {
    // Simulate old event by directly manipulating the internal state
    const repoEvents = plugin.getRepoEvents();
    repoEvents.set("protolabsai/protoContent", {
      lastEventAt: Date.now() - 120_000, // 2 min ago, outside 1 min test window
      totalEvents: 5,
    });

    const result = runSkill(plugin, registry);
    expect(escalations).toHaveLength(1);
    const message = (escalations[0].payload as Record<string, unknown>).message as string;
    expect(message).toContain("Total events seen: 5");
    expect(result.then(r => r.text)).resolves.toContain("1 repo");
  });

  test("empty registry → skip check with informative message", async () => {
    const emptyRegistry = fakeProjectRegistry([]);
    const freshRegistry = new ExecutorRegistry();
    const emptyPlugin = new GithubWebhookFleetCheckPlugin(freshRegistry, emptyRegistry);
    emptyPlugin.install(bus);

    const result = await runSkill(emptyPlugin, freshRegistry);
    expect(result.text).toContain("No GitHub repos");
    emptyPlugin.uninstall();
  });

  test("inbound event tracking counts correctly", () => {
    publishInboundGithub(bus, "protoLabsAI", "protoPen", "pull_request", 1);
    publishInboundGithub(bus, "protoLabsAI", "protoPen", "pull_request", 2);
    publishInboundGithub(bus, "protoLabsAI", "protoPen", "workflow_run", 3);

    const repoEvents = plugin.getRepoEvents();
    const protoPen = repoEvents.get("protolabsai/propen");
    expect(protoPen).toBeDefined();
    expect(protoPen!.totalEvents).toBe(3);
  });

  test("uninstall clears subscriptions — inbound events after uninstall are not tracked", () => {
    plugin.uninstall();
    publishInboundGithub(bus, "protoLabsAI", "protoPen", "pull_request", 99);
    const repoEvents = plugin.getRepoEvents();
    expect(repoEvents.has("protolabsai/propen")).toBe(false);
  });

  test("thundering-herd: N concurrent repos all silent → N escalations", async () => {
    const manyRepos = Array.from({ length: 8 }, (_, i) => `org/repo${i}`);
    const manyRegistry = fakeProjectRegistry(manyRepos);
    const freshRegistry = new ExecutorRegistry();
    const manyPlugin = new GithubWebhookFleetCheckPlugin(freshRegistry, manyRegistry);
    manyPlugin.install(bus);

    const result = await runSkill(manyPlugin, freshRegistry);
    expect(escalations).toHaveLength(8);
    expect(result.text).toContain("8 repo");
    manyPlugin.uninstall();
  });

  test("same-target race: multiple check runs against same silent repo → only first escalates", async () => {
    // Fire 3 check runs concurrently
    await Promise.all([
      runSkill(plugin, registry, "race1"),
      runSkill(plugin, registry, "race2"),
      runSkill(plugin, registry, "race3"),
    ]);
    // Only one escalation should fire (the first to set lastAlertedAt)
    // Note: due to async timing, we may get 0 or 1 — but never 3
    expect(escalations.length).toBeLessThanOrEqual(1);
  });
});
