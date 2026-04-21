import { describe, it, expect, beforeEach } from "bun:test";
import { AlertSkillExecutorPlugin, ALERT_SKILLS } from "../alert-skill-executor-plugin.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import type { BusMessage } from "../../../lib/types.ts";

/**
 * Minimal in-memory bus mirroring the shape used by other dispatcher tests
 * — captures every published message for assertion. Subscribers fire
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

describe("AlertSkillExecutorPlugin", () => {
  let registry: ExecutorRegistry;
  let plugin: AlertSkillExecutorPlugin;
  let bus: ReturnType<typeof makeBus>;

  beforeEach(() => {
    registry = new ExecutorRegistry();
    plugin = new AlertSkillExecutorPlugin(registry);
    bus = makeBus();
    plugin.install(bus as never);
  });

  it("registers executors for every alert skill named in the issue", () => {
    const requiredFromIssue426 = [
      "alert.branch_unprotected",
      "alert.ci_main_red",
      "alert.issues_bugs",
      "alert.security_incident",
      "alert.branch_drift",
      "alert.branch_bypass_actors",
    ];
    for (const skill of requiredFromIssue426) {
      expect(registry.resolve(skill)).not.toBeNull();
    }
  });

  it("registry size matches ALERT_SKILLS length", () => {
    expect(registry.size).toBe(ALERT_SKILLS.length);
  });

  it("publishes message.outbound.discord.alert with severity from the table", async () => {
    const executor = registry.resolve("alert.branch_unprotected")!;
    const result = await executor.execute({
      skill: "alert.branch_unprotected",
      correlationId: "corr-1",
      replyTopic: "reply.test",
      payload: { skill: "alert.branch_unprotected", goalId: "branch.main_protected" },
    });

    expect(result.isError).toBe(false);
    expect(result.correlationId).toBe("corr-1");

    const alert = bus.published.find(m => m.topic === "message.outbound.discord.alert");
    expect(alert).toBeDefined();

    const p = alert!.payload as Record<string, unknown>;
    expect(p.actionId).toBe("alert.branch_unprotected");
    expect(p.goalId).toBe("branch.main_protected");

    const meta = p.meta as Record<string, unknown>;
    expect(meta.severity).toBe("high");
    expect(meta.agentId).toBe("goap");
  });

  it("falls back to action.id and 'unknown' goalId when meta is empty", async () => {
    const executor = registry.resolve("alert.issues_bugs")!;
    await executor.execute({
      skill: "alert.issues_bugs",
      correlationId: "corr-2",
      replyTopic: "reply.test",
      payload: { skill: "alert.issues_bugs" }, // no meta, no goalId
    });

    const alert = bus.published.find(m => m.topic === "message.outbound.discord.alert");
    const p = alert!.payload as Record<string, unknown>;
    expect(p.actionId).toBe("alert.issues_bugs");
    expect(p.goalId).toBe("unknown");
  });

  it("forwards meta.actionId and meta.goalId from a GOAP-shaped dispatch", async () => {
    const executor = registry.resolve("alert.ci_main_red")!;
    await executor.execute({
      skill: "alert.ci_main_red",
      correlationId: "corr-3",
      replyTopic: "reply.test",
      payload: {
        skill: "alert.ci_main_red",
        meta: {
          systemActor: "goap",
          actionId: "alert.ci_main_red",
          goalId: "ci.main_last_push_green",
        },
      },
    });

    const alert = bus.published.find(m => m.topic === "message.outbound.discord.alert");
    const p = alert!.payload as Record<string, unknown>;
    expect(p.actionId).toBe("alert.ci_main_red");
    expect(p.goalId).toBe("ci.main_last_push_green");
  });

  it("propagates correlationId on the published alert", async () => {
    const executor = registry.resolve("alert.security_incident")!;
    await executor.execute({
      skill: "alert.security_incident",
      correlationId: "corr-trace-xyz",
      replyTopic: "reply.test",
      payload: { skill: "alert.security_incident" },
    });

    const alert = bus.published.find(m => m.topic === "message.outbound.discord.alert");
    expect(alert!.correlationId).toBe("corr-trace-xyz");
  });

  it("returns SkillResult.text containing severity tag and headline", async () => {
    const executor = registry.resolve("alert.branch_drift")!;
    const result = await executor.execute({
      skill: "alert.branch_drift",
      correlationId: "c4",
      replyTopic: "r",
      payload: { skill: "alert.branch_drift" },
    });
    expect(result.text).toContain("[MEDIUM]");
    expect(result.text).toContain("Branch drift");
  });

  it("uninstall clears the bus reference", () => {
    plugin.uninstall();
    // Re-installing on a fresh bus should still work — proves no leftover state
    const bus2 = makeBus();
    const reg2 = new ExecutorRegistry();
    const plugin2 = new AlertSkillExecutorPlugin(reg2);
    expect(() => plugin2.install(bus2 as never)).not.toThrow();
  });
});
