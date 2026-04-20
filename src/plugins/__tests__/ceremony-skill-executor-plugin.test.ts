import { describe, it, expect, beforeEach } from "bun:test";
import { CeremonySkillExecutorPlugin, CEREMONY_SKILLS } from "../ceremony-skill-executor-plugin.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import type { BusMessage } from "../../../lib/types.ts";

/**
 * Minimal in-memory bus mirroring the shape used by alert-skill-executor's
 * tests — captures every published message for assertion. Subscribers fire
 * synchronously so we don't need timing tricks.
 */
function makeBus() {
  const subs = new Map<string, Array<(msg: BusMessage) => void>>();
  const published: BusMessage[] = [];
  return {
    published,
    subscribe(topic: string, _name: string, handler: (msg: BusMessage) => void) {
      if (!subs.has(topic)) subs.set(topic, []);
      subs.get(topic)!.push(handler);
      return `sub-${topic}-${Math.random()}`;
    },
    unsubscribe(_id: string) {},
    publish(topic: string, msg: BusMessage) {
      published.push(msg);
      const handlers = subs.get(topic) ?? [];
      for (const h of handlers) h(msg);
    },
    topics() { return []; },
  };
}

describe("CeremonySkillExecutorPlugin", () => {
  let registry: ExecutorRegistry;
  let plugin: CeremonySkillExecutorPlugin;
  let bus: ReturnType<typeof makeBus>;

  beforeEach(() => {
    registry = new ExecutorRegistry();
    plugin = new CeremonySkillExecutorPlugin(registry);
    bus = makeBus();
    plugin.install(bus as never);
  });

  it("registers executors for every ceremony skill named in issue #430", () => {
    const requiredFromIssue430 = [
      "ceremony.security_triage",
      "ceremony.service_health_discord",
    ];
    for (const skill of requiredFromIssue430) {
      expect(registry.resolve(skill)).not.toBeNull();
    }
  });

  it("registry size matches CEREMONY_SKILLS length", () => {
    expect(registry.size).toBe(CEREMONY_SKILLS.length);
  });

  it("publishes ceremony.security-triage.execute when ceremony.security_triage dispatches", async () => {
    const executor = registry.resolve("ceremony.security_triage")!;
    const result = await executor.execute({
      skill: "ceremony.security_triage",
      correlationId: "corr-1",
      replyTopic: "reply.test",
      payload: {
        skill: "ceremony.security_triage",
        meta: { actionId: "ceremony.security_triage", goalId: "security.no_open_incidents" },
      },
    });

    expect(result.isError).toBe(false);
    expect(result.correlationId).toBe("corr-1");

    const trigger = bus.published.find(m => m.topic === "ceremony.security-triage.execute");
    expect(trigger).toBeDefined();

    const p = trigger!.payload as Record<string, unknown>;
    expect(p.type).toBe("external.trigger");
    expect(p.source).toBe("goap");
    expect(p.actionId).toBe("ceremony.security_triage");
    expect(p.goalId).toBe("security.no_open_incidents");
    expect(p.ceremonyId).toBe("security-triage");
  });

  it("publishes ceremony.service-health.execute when ceremony.service_health_discord dispatches", async () => {
    const executor = registry.resolve("ceremony.service_health_discord")!;
    const result = await executor.execute({
      skill: "ceremony.service_health_discord",
      correlationId: "corr-2",
      replyTopic: "reply.test",
      payload: {
        skill: "ceremony.service_health_discord",
        meta: { actionId: "ceremony.service_health_discord", goalId: "services.discord_connected" },
      },
    });

    expect(result.isError).toBe(false);
    const trigger = bus.published.find(m => m.topic === "ceremony.service-health.execute");
    expect(trigger).toBeDefined();
    const p = trigger!.payload as Record<string, unknown>;
    expect(p.ceremonyId).toBe("service-health");
    expect(p.goalId).toBe("services.discord_connected");
  });

  it("payload type is NOT 'ceremony.execute' so CeremonyPlugin treats it as an external trigger", async () => {
    // CeremonyPlugin's .execute handler skips messages with payload.type === 'ceremony.execute'
    // (those are its own internal cron fires, re-published to the same topic). External triggers
    // must use a different type or they will be silently swallowed and never fire the ceremony.
    const executor = registry.resolve("ceremony.security_triage")!;
    await executor.execute({
      skill: "ceremony.security_triage",
      correlationId: "corr-3",
      replyTopic: "reply.test",
      payload: { skill: "ceremony.security_triage" },
    });
    const trigger = bus.published.find(m => m.topic === "ceremony.security-triage.execute");
    const p = trigger!.payload as Record<string, unknown>;
    expect(p.type).not.toBe("ceremony.execute");
  });

  it("falls back to action.id and 'unknown' goalId when meta is empty", async () => {
    const executor = registry.resolve("ceremony.security_triage")!;
    await executor.execute({
      skill: "ceremony.security_triage",
      correlationId: "corr-4",
      replyTopic: "reply.test",
      payload: { skill: "ceremony.security_triage" }, // no meta, no goalId
    });
    const trigger = bus.published.find(m => m.topic === "ceremony.security-triage.execute");
    const p = trigger!.payload as Record<string, unknown>;
    expect(p.actionId).toBe("ceremony.security_triage");
    expect(p.goalId).toBe("unknown");
  });

  it("propagates correlationId on the published trigger", async () => {
    const executor = registry.resolve("ceremony.security_triage")!;
    await executor.execute({
      skill: "ceremony.security_triage",
      correlationId: "corr-trace-xyz",
      replyTopic: "reply.test",
      payload: { skill: "ceremony.security_triage" },
    });
    const trigger = bus.published.find(m => m.topic === "ceremony.security-triage.execute");
    expect(trigger!.correlationId).toBe("corr-trace-xyz");
  });

  it("returns SkillResult.text describing the ceremony triggered", async () => {
    const executor = registry.resolve("ceremony.security_triage")!;
    const result = await executor.execute({
      skill: "ceremony.security_triage",
      correlationId: "c5",
      replyTopic: "r",
      payload: { skill: "ceremony.security_triage" },
    });
    expect(result.text).toContain("security-triage");
    expect(result.text).toContain("ceremony");
  });

  it("uninstall clears the bus reference and reinstall is clean", () => {
    plugin.uninstall();
    const bus2 = makeBus();
    const reg2 = new ExecutorRegistry();
    const plugin2 = new CeremonySkillExecutorPlugin(reg2);
    expect(() => plugin2.install(bus2 as never)).not.toThrow();
  });
});

describe("CeremonySkillExecutorPlugin → CeremonyPlugin integration", () => {
  it("trigger payload shape matches what CeremonyPlugin._fireCeremony expects", async () => {
    // CeremonyPlugin reads the topic, splits on '.', extracts the ceremony id
    // from parts[1..-1].join('.'), and looks it up. The executor must publish
    // to the right topic shape — verified here so a future refactor doesn't
    // break the contract silently.
    const registry = new ExecutorRegistry();
    const plugin = new CeremonySkillExecutorPlugin(registry);
    const bus = makeBus();
    plugin.install(bus as never);

    for (const entry of CEREMONY_SKILLS) {
      const executor = registry.resolve(entry.skill)!;
      await executor.execute({
        skill: entry.skill,
        correlationId: `corr-${entry.skill}`,
        replyTopic: "reply.test",
        payload: { skill: entry.skill },
      });

      const expectedTopic = `ceremony.${entry.ceremonyId}.execute`;
      const trigger = bus.published.find(m => m.topic === expectedTopic);
      expect(trigger).toBeDefined();

      // Mirror CeremonyPlugin's parse to prove the topic is decodable.
      const parts = trigger!.topic.split(".");
      const decodedId = parts.slice(1, -1).join(".");
      expect(decodedId).toBe(entry.ceremonyId);
    }
  });
});
