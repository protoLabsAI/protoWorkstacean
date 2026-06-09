import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { SkillDispatcherPlugin } from "../skill-dispatcher-plugin.ts";
import { ExecutorRegistry } from "../executor-registry.ts";
import { FunctionExecutor } from "../executors/function-executor.ts";
import type { BusMessage } from "../../../lib/types.ts";
import type { SkillRequest, SkillResult } from "../types.ts";

// Minimal in-memory event bus for tests
function makeBus() {
  const subs = new Map<string, Array<(msg: BusMessage) => void>>();
  const published: BusMessage[] = [];

  return {
    published,
    subscribe(topic: string, _name: string, handler: (msg: BusMessage) => void) {
      const key = topic.replace("#", "*");
      if (!subs.has(key)) subs.set(key, []);
      subs.get(key)!.push(handler);
      return `sub-${topic}-${Math.random()}`;
    },
    unsubscribe(_id: string) {},
    publish(topic: string, msg: BusMessage) {
      published.push(msg);
      for (const [pattern, handlers] of subs) {
        if (pattern === topic || pattern === "*" || topic.startsWith(pattern.replace("*", ""))) {
          for (const h of handlers) h(msg);
        }
      }
    },
    topics() { return []; },
  };
}

function makeMsg(overrides: Partial<BusMessage> = {}): BusMessage {
  return {
    id: "msg-id-1",
    correlationId: "trace-abc",
    topic: "agent.skill.request",
    timestamp: Date.now(),
    payload: { skill: "daily_standup" },
    ...overrides,
  };
}

describe("SkillDispatcherPlugin", () => {
  let registry: ExecutorRegistry;
  let plugin: SkillDispatcherPlugin;
  let bus: ReturnType<typeof makeBus>;

  beforeEach(() => {
    registry = new ExecutorRegistry();
    plugin = new SkillDispatcherPlugin(registry, "/tmp");
    bus = makeBus();
    plugin.install(bus as never);
  });

  afterEach(() => {
    plugin.uninstall();
  });

  it("dispatches to registered executor and publishes result", async () => {
    const fn = mock(async (req: SkillRequest): Promise<SkillResult> => ({
      text: "done",
      isError: false,
      correlationId: req.correlationId,
    }));
    registry.register("daily_standup", new FunctionExecutor(fn));

    const msg = makeMsg({ reply: { topic: "reply.test" } });
    bus.publish("agent.skill.request", msg);

    // Wait for async dispatch
    await new Promise(r => setTimeout(r, 10));

    expect(fn).toHaveBeenCalledTimes(1);
    const req = (fn.mock.calls[0] as [SkillRequest])[0];
    expect(req.skill).toBe("daily_standup");
    expect(req.correlationId).toBe("trace-abc");
    expect(req.parentId).toBe("msg-id-1");
    expect(req.replyTopic).toBe("reply.test");

    const reply = bus.published.find(m => m.topic === "reply.test");
    expect(reply).toBeDefined();
    expect((reply!.payload as Record<string, unknown>).content).toBe("done");
    expect((reply!.payload as Record<string, unknown>).error).toBeUndefined();
  });

  it("flow.item.created carries the target agent (canvas attribution + Executions filter)", async () => {
    registry.register(
      "some_skill",
      new FunctionExecutor(async (req: SkillRequest): Promise<SkillResult> => ({ text: "ok", isError: false, correlationId: req.correlationId })),
      { agentName: "ava" },
    );
    bus.publish("agent.skill.request", makeMsg({ payload: { skill: "some_skill", targets: ["ava"] }, reply: { topic: "reply.t" } }));
    await new Promise((r) => setTimeout(r, 10));

    const created = bus.published.find((m) => m.topic === "flow.item.created");
    expect(created).toBeDefined();
    const meta = (created!.payload as { meta?: Record<string, unknown> }).meta;
    expect(meta?.targetAgent).toBe("ava");

    const completed = bus.published.find((m) => m.topic === "flow.item.completed");
    expect((completed!.payload as { meta?: Record<string, unknown> }).meta?.targetAgent).toBe("ava");
  });

  it("publishes error response when no executor found", async () => {
    const msg = makeMsg({ reply: { topic: "reply.test" } });
    bus.publish("agent.skill.request", msg);
    await new Promise(r => setTimeout(r, 10));

    const reply = bus.published.find(m => m.topic === "reply.test");
    expect(reply).toBeDefined();
    expect((reply!.payload as Record<string, unknown>).error).toContain("daily_standup");
  });

  it("drops message with no skill and publishes error on default reply topic", async () => {
    const msg = makeMsg({ payload: {}, correlationId: "xyz" });
    bus.publish("agent.skill.request", msg);
    await new Promise(r => setTimeout(r, 10));

    const reply = bus.published.find(m => m.topic === "agent.skill.response.xyz");
    expect(reply).toBeDefined();
    expect((reply!.payload as Record<string, unknown>).error).toContain("No skill");
  });

  it("propagates executor error as error response", async () => {
    registry.register("failing_skill", new FunctionExecutor(async (req) => ({
      text: "something broke",
      isError: true,
      correlationId: req.correlationId,
    })));

    const msg = makeMsg({ payload: { skill: "failing_skill" }, reply: { topic: "reply.fail" } });
    bus.publish("agent.skill.request", msg);
    await new Promise(r => setTimeout(r, 10));

    const reply = bus.published.find(m => m.topic === "reply.fail");
    expect(reply).toBeDefined();
    expect((reply!.payload as Record<string, unknown>).error).toBeDefined();
    expect((reply!.payload as Record<string, unknown>).content).toBeUndefined();
  });

  it("resolves by target agent name", async () => {
    const fn = mock(async (req: SkillRequest): Promise<SkillResult> => ({
      text: "ava result",
      isError: false,
      correlationId: req.correlationId,
    }));
    registry.register("some_skill", new FunctionExecutor(fn), { agentName: "ava" });

    const msg = makeMsg({
      payload: { skill: "some_skill", targets: ["ava"] },
      reply: { topic: "reply.ava" },
    });
    bus.publish("agent.skill.request", msg);
    await new Promise(r => setTimeout(r, 10));

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses default reply topic when msg.reply is absent", async () => {
    const msg = makeMsg({ payload: { skill: "unknown" } }); // no reply field
    bus.publish("agent.skill.request", msg);
    await new Promise(r => setTimeout(r, 10));

    const defaultTopic = `agent.skill.response.trace-abc`;
    const reply = bus.published.find(m => m.topic === defaultTopic);
    expect(reply).toBeDefined();
  });

  describe("dispatch.dropped.* telemetry", () => {
    it("publishes dispatch.dropped.no_skill when skill is missing", async () => {
      const msg = makeMsg({ payload: {} }); // no skill, no skillHint
      bus.publish("agent.skill.request", msg);
      await new Promise(r => setTimeout(r, 10));

      const drop = bus.published.find(m => m.topic === "dispatch.dropped.no_skill");
      expect(drop).toBeDefined();
      const p = drop!.payload as Record<string, unknown>;
      expect(p.reason).toBe("no_skill");
      expect(p.correlationId).toBe("trace-abc");
      expect(typeof p.message).toBe("string");
    });

    it("publishes dispatch.dropped.target_unresolved when no executor matches", async () => {
      const msg = makeMsg({
        payload: { skill: "ghost_skill", targets: ["nobody"] },
      });
      bus.publish("agent.skill.request", msg);
      await new Promise(r => setTimeout(r, 10));

      const drop = bus.published.find(m => m.topic === "dispatch.dropped.target_unresolved");
      expect(drop).toBeDefined();
      const p = drop!.payload as Record<string, unknown>;
      expect(p.reason).toBe("target_unresolved");
      expect(p.skill).toBe("ghost_skill");
      expect(p.targets).toEqual(["nobody"]);
    });

    it("publishes dispatch.dropped.cooldown with cooldownKey + remainingMs when cooldown trips", async () => {
      const fn = mock(async (req: SkillRequest): Promise<SkillResult> => ({
        text: "ok",
        isError: false,
        correlationId: req.correlationId,
      }));
      // bug_triage has a 30s default cooldown
      registry.register("bug_triage", new FunctionExecutor(fn));

      // First dispatch — should succeed and seed lastDispatchAt
      bus.publish("agent.skill.request", makeMsg({
        correlationId: "trace-first",
        payload: { skill: "bug_triage", meta: { owner: "protoLabsAI", repo: "foo" } },
      }));
      await new Promise(r => setTimeout(r, 10));

      // Second dispatch in-window — should drop with cooldown reason
      bus.publish("agent.skill.request", makeMsg({
        correlationId: "trace-second",
        payload: { skill: "bug_triage", meta: { owner: "protoLabsAI", repo: "foo" } },
      }));
      await new Promise(r => setTimeout(r, 10));

      const drops = bus.published.filter(m => m.topic === "dispatch.dropped.cooldown");
      expect(drops).toHaveLength(1);
      const p = drops[0].payload as Record<string, unknown>;
      expect(p.reason).toBe("cooldown");
      expect(p.skill).toBe("bug_triage");
      expect(typeof p.cooldownKey).toBe("string");
      expect(typeof p.cooldownWindowMs).toBe("number");
      expect(typeof p.cooldownRemainingMs).toBe("number");
      expect(p.correlationId).toBe("trace-second");
      // executor should NOT have been called for the dropped dispatch
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
