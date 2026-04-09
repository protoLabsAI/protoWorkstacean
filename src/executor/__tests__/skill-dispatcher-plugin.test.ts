import { describe, it, expect, mock, beforeEach } from "bun:test";
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
    expect((reply!.payload as Record<string, unknown>).result).toBe("done");
    expect((reply!.payload as Record<string, unknown>).error).toBeUndefined();
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
    expect((reply!.payload as Record<string, unknown>).result).toBeUndefined();
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
});
