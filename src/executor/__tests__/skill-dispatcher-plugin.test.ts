import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { SkillDispatcherPlugin } from "../skill-dispatcher-plugin.ts";
import { assembleContext } from "../../../lib/conversation/context-assembler.ts";
import { ExecutorRegistry } from "../executor-registry.ts";
import { FunctionExecutor } from "../executors/function-executor.ts";
import { ProtoSdkExecutor } from "../executors/proto-sdk-executor.ts";
import { AgentExecutor } from "../../agent-runtime/agent-executor.ts";
import { ToolRegistry } from "../../agent-runtime/tool-registry.ts";
import type { BusMessage } from "../../../lib/types.ts";
import type { SkillRequest, SkillResult } from "../types.ts";
import type { AgentDefinition } from "../../agent-runtime/types.ts";
import type { GraphitiClient } from "../../../lib/memory/graphiti-client.ts";
import type { ConversationTurn } from "../../../lib/types.ts";

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
});

// ── Memory enrichment path ─────────────────────────────────────────────────────

/** Build a minimal GraphitiClient stub. */
function makeGraphitiStub(overrides: Partial<GraphitiClient> = {}): GraphitiClient {
  return {
    getContextBlock: mock(async () => ""),
    addEpisode: mock(async () => {}),
    search: mock(async () => []),
    clearUser: mock(async () => {}),
    isHealthy: mock(async () => true),
    ...overrides,
  } as unknown as GraphitiClient;
}

function makeUserMsg(overrides: Partial<BusMessage> = {}): BusMessage {
  return {
    id: "msg-user-1",
    correlationId: "corr-user",
    topic: "agent.skill.request",
    timestamp: Date.now(),
    source: { interface: "discord", userId: "111222333", channelId: "ch-9" },
    payload: { skill: "daily_standup", content: "What is happening today?", targets: ["ava"] },
    reply: { topic: "reply.user" },
    ...overrides,
  };
}

describe("SkillDispatcherPlugin — memory enrichment", () => {
  let registry: ExecutorRegistry;
  let graphiti: GraphitiClient;
  let plugin: SkillDispatcherPlugin;
  let bus: ReturnType<typeof makeBus>;

  beforeEach(() => {
    registry = new ExecutorRegistry();
    graphiti = makeGraphitiStub();
    plugin = new SkillDispatcherPlugin(registry, "/tmp", graphiti);
    bus = makeBus();
    plugin.install(bus as never);
  });

  afterEach(() => {
    plugin.uninstall();
  });

  it("skips enrichment when source has no userId", async () => {
    registry.register("daily_standup", new FunctionExecutor(async (req) => ({
      text: "done", isError: false, correlationId: req.correlationId,
    })));

    const msg = makeUserMsg({ source: { interface: "discord" } }); // no userId
    bus.publish("agent.skill.request", msg);
    await new Promise(r => setTimeout(r, 20));

    expect(graphiti.getContextBlock).not.toHaveBeenCalled();
  });

  it("skips enrichment when source.interface is 'cron'", async () => {
    registry.register("daily_standup", new FunctionExecutor(async (req) => ({
      text: "done", isError: false, correlationId: req.correlationId,
    })));

    const msg = makeUserMsg({ source: { interface: "cron", userId: "system" } });
    bus.publish("agent.skill.request", msg);
    await new Promise(r => setTimeout(r, 20));

    expect(graphiti.getContextBlock).not.toHaveBeenCalled();
  });

  it("calls getContextBlock for shared and agent-scoped groups", async () => {
    registry.register("daily_standup", new FunctionExecutor(async (req) => ({
      text: "done", isError: false, correlationId: req.correlationId,
    })), { agentName: "ava" });

    bus.publish("agent.skill.request", makeUserMsg());
    await new Promise(r => setTimeout(r, 20));

    const calls = (graphiti.getContextBlock as ReturnType<typeof mock>).mock.calls as [string, string][];
    const groupIds = calls.map(c => c[0]);
    expect(groupIds).toContain("user_discord_111222333");                  // shared (no users.yaml in /tmp)
    expect(groupIds).toContain("agent_ava__user_discord_111222333"); // agent-scoped
  });

  it("prepends context block to content when Graphiti returns facts", async () => {
    const ctxBlock = "[User context — user:josh]\n- Prefers bullet points\n";
    graphiti = makeGraphitiStub({
      getContextBlock: mock(async () => ctxBlock),
    });
    plugin = new SkillDispatcherPlugin(registry, "/tmp", graphiti);
    bus = makeBus();
    plugin.install(bus as never);

    let receivedContent: string | undefined;
    registry.register("daily_standup", new FunctionExecutor(async (req) => {
      receivedContent = req.content;
      return { text: "ok", isError: false, correlationId: req.correlationId };
    }));

    bus.publish("agent.skill.request", makeUserMsg());
    await new Promise(r => setTimeout(r, 20));

    expect(receivedContent).toContain("[User context — user:josh]");
    expect(receivedContent).toContain("What is happening today?");
    expect(receivedContent!.indexOf("[User context")).toBeLessThan(
      receivedContent!.indexOf("What is happening today?")
    );
  });

  it("passes original content (without context prefix) to addEpisode", async () => {
    const ctxBlock = "[User context — user:josh]\n- Prefers bullets\n";
    graphiti = makeGraphitiStub({
      getContextBlock: mock(async () => ctxBlock),
      addEpisode: mock(async () => {}),
    });
    plugin = new SkillDispatcherPlugin(registry, "/tmp", graphiti);
    bus = makeBus();
    plugin.install(bus as never);

    registry.register("daily_standup", new FunctionExecutor(async (req) => ({
      text: "agent response", isError: false, correlationId: req.correlationId,
    })));

    bus.publish("agent.skill.request", makeUserMsg());
    await new Promise(r => setTimeout(r, 30));

    const episodeCalls = (graphiti.addEpisode as ReturnType<typeof mock>).mock.calls as [{ userMessage: string }][];
    expect(episodeCalls.length).toBeGreaterThan(0);
    const { userMessage } = episodeCalls[0]![0];
    // Must be original content, not prefixed
    expect(userMessage).toBe("What is happening today?");
    expect(userMessage).not.toContain("[User context");
  });

  it("stores episode in both shared and agent-scoped groups", async () => {
    registry.register("daily_standup", new FunctionExecutor(async (req) => ({
      text: "agent response", isError: false, correlationId: req.correlationId,
    })), { agentName: "ava" });

    bus.publish("agent.skill.request", makeUserMsg());
    await new Promise(r => setTimeout(r, 30));

    const episodeCalls = (graphiti.addEpisode as ReturnType<typeof mock>).mock.calls as [{ groupId: string }][];
    const storedGroups = episodeCalls.map(c => c[0].groupId);
    expect(storedGroups).toContain("user_discord_111222333");
    expect(storedGroups).toContain("agent_ava__user_discord_111222333");
  });

  it("does NOT store episode when result.isError is true", async () => {
    registry.register("daily_standup", new FunctionExecutor(async (req) => ({
      text: "error occurred", isError: true, correlationId: req.correlationId,
    })));

    bus.publish("agent.skill.request", makeUserMsg());
    await new Promise(r => setTimeout(r, 30));

    expect(graphiti.addEpisode).not.toHaveBeenCalled();
  });

  it("does NOT store episode when result has no text", async () => {
    registry.register("daily_standup", new FunctionExecutor(async (req) => ({
      text: "", isError: false, correlationId: req.correlationId,
    })));

    bus.publish("agent.skill.request", makeUserMsg());
    await new Promise(r => setTimeout(r, 30));

    expect(graphiti.addEpisode).not.toHaveBeenCalled();
  });

  it("dispatch succeeds even when getContextBlock throws", async () => {
    graphiti = makeGraphitiStub({
      getContextBlock: mock(async () => { throw new Error("graphiti down"); }),
    });
    plugin = new SkillDispatcherPlugin(registry, "/tmp", graphiti);
    bus = makeBus();
    plugin.install(bus as never);

    registry.register("daily_standup", new FunctionExecutor(async (req) => ({
      text: "ok anyway", isError: false, correlationId: req.correlationId,
    })));

    bus.publish("agent.skill.request", makeUserMsg());
    await new Promise(r => setTimeout(r, 20));

    const reply = bus.published.find(m => m.topic === "reply.user");
    expect(reply).toBeDefined();
    expect((reply!.payload as Record<string, unknown>).content).toBe("ok anyway");
  });
});

// ── assembleContext pure function ──────────────────────────────────────────────

function makeTurn(overrides: Partial<ConversationTurn> = {}): ConversationTurn {
  return {
    role: "user",
    text: "Hello",
    channelId: "discord",
    agentName: "chat",
    timestamp: new Date("2024-01-01T12:00:00.000Z").getTime(),
    ...overrides,
  };
}

describe("assembleContext", () => {
  it("emits only <current_message> when no memory and no turns", () => {
    const result = assembleContext(undefined, [], "Hello there");
    expect(result).toBe("<current_message>\nHello there\n</current_message>");
    expect(result).not.toContain("<recalled_memory>");
    expect(result).not.toContain("<recent_conversation>");
  });

  it("includes <recalled_memory> with instruction when memory is provided", () => {
    const result = assembleContext("- User prefers bullets", [], "Hello");
    expect(result).toContain("<recalled_memory>");
    expect(result).toContain("</recalled_memory>");
    expect(result).toContain("- User prefers bullets");
    expect(result).toContain("do NOT repeat them back");
    expect(result).toContain("<current_message>");
    expect(result).not.toContain("<recent_conversation>");
  });

  it("includes <recent_conversation> when turns are provided", () => {
    const turns = [
      makeTurn({ role: "user", text: "What time is it?", channelId: "discord" }),
      makeTurn({ role: "assistant", text: "It is noon.", channelId: "discord" }),
    ];
    const result = assembleContext(undefined, turns, "Thanks");
    expect(result).toContain("<recent_conversation>");
    expect(result).toContain("</recent_conversation>");
    expect(result).toContain("What time is it?");
    expect(result).toContain("It is noon.");
    expect(result).not.toContain("<recalled_memory>");
    expect(result).toContain("<current_message>");
  });

  it("labels turns with ISO timestamp, channelId, and role", () => {
    const ts = new Date("2024-06-15T09:30:00.000Z").getTime();
    const turns = [
      makeTurn({ role: "user", text: "Hi", channelId: "slack", timestamp: ts }),
    ];
    const result = assembleContext(undefined, turns, "Next");
    expect(result).toContain("2024-06-15T09:30:00.000Z");
    expect(result).toContain("[slack]");
    expect(result).toContain("User:");
  });

  it("omits channel suffix when channelId is empty", () => {
    const turns = [makeTurn({ channelId: "" })];
    const result = assembleContext(undefined, turns, "Next");
    expect(result).not.toMatch(/\[\]/);
    expect(result).toContain("User:");
  });

  it("labels assistant turns correctly", () => {
    const turns = [makeTurn({ role: "assistant", text: "Hello!" })];
    const result = assembleContext(undefined, turns, "Next");
    expect(result).toContain("Assistant:");
  });

  it("emits all three sections in correct order when all data present", () => {
    const turns = [makeTurn({ text: "Previous question" })];
    const result = assembleContext("Some facts", turns, "Current question");

    const rmPos = result.indexOf("<recalled_memory>");
    const rcPos = result.indexOf("<recent_conversation>");
    const cmPos = result.indexOf("<current_message>");

    expect(rmPos).toBeGreaterThanOrEqual(0);
    expect(rcPos).toBeGreaterThanOrEqual(0);
    expect(cmPos).toBeGreaterThanOrEqual(0);
    expect(rmPos).toBeLessThan(rcPos);
    expect(rcPos).toBeLessThan(cmPos);
  });

  it("does not emit empty <recalled_memory> when memory is empty string", () => {
    const result = assembleContext("", [], "Hello");
    expect(result).not.toContain("<recalled_memory>");
    expect(result).toBe("<current_message>\nHello\n</current_message>");
  });
});

// ── skill.progress emission ────────────────────────────────────────────────────

const minimalAgentDef: AgentDefinition = {
  name: "test-agent",
  role: "general",
  model: "test-model",
  systemPrompt: "You are a test agent.",
  tools: [],
  maxTurns: 5,
  skills: [{ name: "test_skill" }],
};

describe("SkillDispatcherPlugin — skill.progress events", () => {
  it("subscribes to skill.progress and observes tool_call events from ProtoSdkExecutor", async () => {
    const bus = makeBus();
    const registry = new ExecutorRegistry();

    // Stub AgentExecutor.run to simulate a tool_use event via onProgress
    const runSpy = spyOn(AgentExecutor.prototype, "run").mockImplementation(
      async (opts) => {
        opts.onProgress?.({
          eventType: "tool_call",
          correlationId: opts.correlationId,
          toolName: "bash",
        });
        return { text: "done", isError: false };
      },
    );

    const toolRegistry = new ToolRegistry();
    const executor = new ProtoSdkExecutor(minimalAgentDef, toolRegistry, {}, bus as never);
    registry.register("test_skill", executor);

    const plugin = new SkillDispatcherPlugin(registry, "/tmp");
    plugin.install(bus as never);

    const progressEvents: BusMessage[] = [];
    bus.subscribe("skill.progress", "test-observer", (msg) => progressEvents.push(msg));

    bus.publish("agent.skill.request", makeMsg({
      payload: { skill: "test_skill" },
      reply: { topic: "reply.progress-test" },
    }));

    await new Promise(r => setTimeout(r, 30));

    expect(progressEvents.length).toBeGreaterThan(0);
    const ev = progressEvents[0]!;
    expect((ev.payload as Record<string, unknown>).eventType).toBe("tool_call");
    expect((ev.payload as Record<string, unknown>).toolName).toBe("bash");
    expect(ev.topic).toBe("skill.progress");

    runSpy.mockRestore();
    plugin.uninstall();
  });

  it("emits skill.progress with text eventType for assistant text blocks", async () => {
    const bus = makeBus();
    const registry = new ExecutorRegistry();

    const runSpy = spyOn(AgentExecutor.prototype, "run").mockImplementation(
      async (opts) => {
        opts.onProgress?.({
          eventType: "text",
          correlationId: opts.correlationId,
          text: "thinking...",
        });
        return { text: "final result", isError: false };
      },
    );

    const toolRegistry = new ToolRegistry();
    const executor = new ProtoSdkExecutor(minimalAgentDef, toolRegistry, {}, bus as never);
    registry.register("test_skill", executor);

    const plugin = new SkillDispatcherPlugin(registry, "/tmp");
    plugin.install(bus as never);

    const progressEvents: BusMessage[] = [];
    bus.subscribe("skill.progress", "test-observer-text", (msg) => progressEvents.push(msg));

    bus.publish("agent.skill.request", makeMsg({
      payload: { skill: "test_skill" },
      reply: { topic: "reply.progress-text-test" },
    }));

    await new Promise(r => setTimeout(r, 30));

    expect(progressEvents.length).toBeGreaterThan(0);
    const ev = progressEvents[0]!;
    expect((ev.payload as Record<string, unknown>).eventType).toBe("text");
    expect((ev.payload as Record<string, unknown>).text).toBe("thinking...");

    runSpy.mockRestore();
    plugin.uninstall();
  });

  it("does not emit skill.progress when ProtoSdkExecutor has no bus", async () => {
    const bus = makeBus();
    const registry = new ExecutorRegistry();

    const runSpy = spyOn(AgentExecutor.prototype, "run").mockImplementation(
      async (opts) => {
        // onProgress should be undefined when no bus is provided
        opts.onProgress?.({
          eventType: "tool_call",
          correlationId: opts.correlationId,
          toolName: "bash",
        });
        return { text: "done", isError: false };
      },
    );

    const toolRegistry = new ToolRegistry();
    // No bus passed — progress events should not be emitted
    const executor = new ProtoSdkExecutor(minimalAgentDef, toolRegistry, {});
    registry.register("test_skill", executor);

    const plugin = new SkillDispatcherPlugin(registry, "/tmp");
    plugin.install(bus as never);

    const progressEvents: BusMessage[] = [];
    bus.subscribe("skill.progress", "test-no-bus", (msg) => progressEvents.push(msg));

    bus.publish("agent.skill.request", makeMsg({
      payload: { skill: "test_skill" },
      reply: { topic: "reply.no-bus-test" },
    }));

    await new Promise(r => setTimeout(r, 30));

    expect(progressEvents.length).toBe(0);

    runSpy.mockRestore();
    plugin.uninstall();
  });
});
