/**
 * Phase 7 — A2A server adapter round-trips external JSON-RPC calls through
 * the bus and back.
 *
 * Drive the BusAgentExecutor directly (no HTTP layer) so we can inspect the
 * events it publishes to the SDK's ExecutionEventBus. The bus subscribes to
 * agent.skill.request and publishes a response on the correlated reply topic
 * — that's exactly the internal contract SkillDispatcherPlugin satisfies.
 */

import { describe, test, expect } from "bun:test";
import { DefaultExecutionEventBus } from "@a2a-js/sdk/server";
import type { AgentExecutionEvent, RequestContext } from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { BusAgentExecutor } from "../a2a-server.ts";
import type { ApiContext } from "../types.ts";

function makeUserMessage(text: string, metadata: Record<string, unknown> = {}): Message {
  return {
    kind: "message",
    messageId: crypto.randomUUID(),
    role: "user",
    parts: [{ kind: "text", text }],
    metadata,
  };
}

function makeRequestContext(text: string, metadata: Record<string, unknown> = {}): RequestContext {
  const userMessage = makeUserMessage(text, metadata);
  const taskId = crypto.randomUUID();
  const contextId = crypto.randomUUID();
  return {
    userMessage,
    taskId,
    contextId,
  } as RequestContext;
}

describe("BusAgentExecutor (Phase 7)", () => {
  test("publishes agent.skill.request and resolves with the reply content", async () => {
    const bus = new InMemoryEventBus();
    const ctx: ApiContext = {
      workspaceDir: "/tmp",
      bus,
      plugins: [],
      executorRegistry: new ExecutorRegistry(),
    };

    let requestPayload: Record<string, unknown> | undefined;
    let replyTopic: string | undefined;
    bus.subscribe("agent.skill.request", "test", (msg) => {
      requestPayload = msg.payload as Record<string, unknown>;
      replyTopic = msg.reply?.topic;
      // Mimic SkillDispatcherPlugin: publish a response on the replyTopic
      setTimeout(() => {
        bus.publish(msg.reply!.topic!, {
          id: crypto.randomUUID(),
          correlationId: msg.correlationId,
          topic: msg.reply!.topic!,
          timestamp: Date.now(),
          payload: { content: "42", correlationId: msg.correlationId },
        });
      }, 0);
    });

    const adapter = new BusAgentExecutor(ctx);
    const eventBus = new DefaultExecutionEventBus();
    const collected: AgentExecutionEvent[] = [];
    eventBus.on("event", (e) => collected.push(e));
    const done = new Promise<void>(resolve => eventBus.on("finished", () => resolve()));

    const reqCtx = makeRequestContext("What is the answer?", { skillHint: "plan", targets: ["ava"] });

    await adapter.execute(reqCtx, eventBus);
    await done;

    expect(requestPayload).toBeDefined();
    expect((requestPayload as { skill: string }).skill).toBe("plan");
    expect((requestPayload as { targets: string[] }).targets).toEqual(["ava"]);
    expect((requestPayload as { content: string }).content).toBe("What is the answer?");
    expect(replyTopic).toBe(`agent.skill.response.${reqCtx.taskId}`);

    // Events in order: submitted task, working status, completed status (final)
    const taskEvt = collected.find(e => e.kind === "task");
    const workingEvt = collected.find(e => e.kind === "status-update" && "status" in e && (e as { status: { state: string } }).status.state === "working");
    const completedEvt = collected.find(e => e.kind === "status-update" && "status" in e && (e as { status: { state: string } }).status.state === "completed");
    expect(taskEvt).toBeDefined();
    expect(workingEvt).toBeDefined();
    expect(completedEvt).toBeDefined();

    // Terminal event should carry the reply content + final: true
    const finalEvt = completedEvt as { final: boolean; status: { message?: { parts: Array<{ text?: string }> } } };
    expect(finalEvt.final).toBe(true);
    const terminalText = finalEvt.status.message?.parts?.map(p => p.text ?? "").join("") ?? "";
    expect(terminalText).toBe("42");
  });

  test("error response maps to failed status-update", async () => {
    const bus = new InMemoryEventBus();
    const ctx: ApiContext = {
      workspaceDir: "/tmp",
      bus,
      plugins: [],
      executorRegistry: new ExecutorRegistry(),
    };

    bus.subscribe("agent.skill.request", "test", (msg) => {
      setTimeout(() => {
        bus.publish(msg.reply!.topic!, {
          id: crypto.randomUUID(),
          correlationId: msg.correlationId,
          topic: msg.reply!.topic!,
          timestamp: Date.now(),
          payload: { error: "boom", correlationId: msg.correlationId },
        });
      }, 0);
    });

    const adapter = new BusAgentExecutor(ctx);
    const eventBus = new DefaultExecutionEventBus();
    const collected: AgentExecutionEvent[] = [];
    eventBus.on("event", (e) => collected.push(e));
    const done = new Promise<void>(resolve => eventBus.on("finished", () => resolve()));

    const reqCtx = makeRequestContext("Broken request", { skillHint: "chat" });
    await adapter.execute(reqCtx, eventBus);
    await done;

    const failedEvt = collected.find(
      e => e.kind === "status-update" && "status" in e && (e as { status: { state: string } }).status.state === "failed",
    ) as { final: boolean; status: { message?: { parts: Array<{ text?: string }> } } } | undefined;
    expect(failedEvt).toBeDefined();
    expect(failedEvt!.final).toBe(true);
    const text = failedEvt!.status.message?.parts?.map(p => p.text ?? "").join("") ?? "";
    expect(text).toBe("boom");
  });

  test("defaults targets to ['ava'] when metadata omits targets (#471)", async () => {
    const bus = new InMemoryEventBus();
    const ctx: ApiContext = {
      workspaceDir: "/tmp",
      bus,
      plugins: [],
      executorRegistry: new ExecutorRegistry(),
    };

    let requestPayload: Record<string, unknown> | undefined;
    bus.subscribe("agent.skill.request", "test", (msg) => {
      requestPayload = msg.payload as Record<string, unknown>;
      setTimeout(() => {
        bus.publish(msg.reply!.topic!, {
          id: crypto.randomUUID(),
          correlationId: msg.correlationId,
          topic: msg.reply!.topic!,
          timestamp: Date.now(),
          payload: { content: "hi from ava", correlationId: msg.correlationId },
        });
      }, 0);
    });

    // Capture the info log to confirm fail-fast-and-loud fallback visibility
    const origLog = console.log;
    const logCalls: string[] = [];
    console.log = (...args: unknown[]) => {
      logCalls.push(args.map(String).join(" "));
    };

    try {
      const adapter = new BusAgentExecutor(ctx);
      const eventBus = new DefaultExecutionEventBus();
      const done = new Promise<void>(resolve => eventBus.on("finished", () => resolve()));

      // No metadata at all — mimics the protoVoice repro curl from #471
      const reqCtx = makeRequestContext("Brief sitrep — who are you?");
      await adapter.execute(reqCtx, eventBus);
      await done;

      expect(requestPayload).toBeDefined();
      expect((requestPayload as { targets: string[] }).targets).toEqual(["ava"]);
      expect((requestPayload as { skill: string }).skill).toBe("chat");
      expect(logCalls.some(l => l.includes("[a2a-server]") && l.includes("defaulting to [ava]"))).toBe(true);
    } finally {
      console.log = origLog;
    }
  });

  test("preserves explicit targets when caller specifies them (#471)", async () => {
    const bus = new InMemoryEventBus();
    const ctx: ApiContext = {
      workspaceDir: "/tmp",
      bus,
      plugins: [],
      executorRegistry: new ExecutorRegistry(),
    };

    let requestPayload: Record<string, unknown> | undefined;
    bus.subscribe("agent.skill.request", "test", (msg) => {
      requestPayload = msg.payload as Record<string, unknown>;
      setTimeout(() => {
        bus.publish(msg.reply!.topic!, {
          id: crypto.randomUUID(),
          correlationId: msg.correlationId,
          topic: msg.reply!.topic!,
          timestamp: Date.now(),
          payload: { content: "ok", correlationId: msg.correlationId },
        });
      }, 0);
    });

    const adapter = new BusAgentExecutor(ctx);
    const eventBus = new DefaultExecutionEventBus();
    const done = new Promise<void>(resolve => eventBus.on("finished", () => resolve()));

    const reqCtx = makeRequestContext("Status check", { targets: ["quinn"] });
    await adapter.execute(reqCtx, eventBus);
    await done;

    expect((requestPayload as { targets: string[] }).targets).toEqual(["quinn"]);
  });

  test("sanitizes raw HTML content payload into a failed status-update (#471)", async () => {
    const bus = new InMemoryEventBus();
    const ctx: ApiContext = {
      workspaceDir: "/tmp",
      bus,
      plugins: [],
      executorRegistry: new ExecutorRegistry(),
    };

    const htmlError = "<!DOCTYPE html>\n<html><head></head><body><pre>Cannot POST /</pre></body></html>";

    bus.subscribe("agent.skill.request", "test", (msg) => {
      setTimeout(() => {
        bus.publish(msg.reply!.topic!, {
          id: crypto.randomUUID(),
          correlationId: msg.correlationId,
          topic: msg.reply!.topic!,
          timestamp: Date.now(),
          payload: { content: htmlError, correlationId: msg.correlationId },
        });
      }, 0);
    });

    const origWarn = console.warn;
    const warnCalls: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args.map(String).join(" "));
    };

    try {
      const adapter = new BusAgentExecutor(ctx);
      const eventBus = new DefaultExecutionEventBus();
      const collected: AgentExecutionEvent[] = [];
      eventBus.on("event", (e) => collected.push(e));
      const done = new Promise<void>(resolve => eventBus.on("finished", () => resolve()));

      const reqCtx = makeRequestContext("prompt", { targets: ["ava"] });
      await adapter.execute(reqCtx, eventBus);
      await done;

      const failedEvt = collected.find(
        e => e.kind === "status-update" && "status" in e && (e as { status: { state: string } }).status.state === "failed",
      ) as { final: boolean; status: { message?: { parts: Array<{ text?: string }> } } } | undefined;
      expect(failedEvt).toBeDefined();
      expect(failedEvt!.final).toBe(true);

      const text = failedEvt!.status.message?.parts?.map(p => p.text ?? "").join("") ?? "";
      expect(text).not.toContain("<!DOCTYPE");
      expect(text).not.toContain("<html");
      expect(text.toLowerCase()).toContain("downstream agent returned an http error");

      // Raw HTML is logged loudly for operators
      expect(warnCalls.some(l => l.includes("<!DOCTYPE"))).toBe(true);
    } finally {
      console.warn = origWarn;
    }
  });

  test("sanitizes HTML that leaks through the error channel (#471)", async () => {
    const bus = new InMemoryEventBus();
    const ctx: ApiContext = {
      workspaceDir: "/tmp",
      bus,
      plugins: [],
      executorRegistry: new ExecutorRegistry(),
    };

    const htmlErrorDirect = "<!DOCTYPE html><html>404 Not Found</html>";

    bus.subscribe("agent.skill.request", "test", (msg) => {
      setTimeout(() => {
        bus.publish(msg.reply!.topic!, {
          id: crypto.randomUUID(),
          correlationId: msg.correlationId,
          topic: msg.reply!.topic!,
          timestamp: Date.now(),
          payload: { error: htmlErrorDirect, correlationId: msg.correlationId },
        });
      }, 0);
    });

    const origWarn = console.warn;
    console.warn = () => {};

    try {
      const adapter = new BusAgentExecutor(ctx);
      const eventBus = new DefaultExecutionEventBus();
      const collected: AgentExecutionEvent[] = [];
      eventBus.on("event", (e) => collected.push(e));
      const done = new Promise<void>(resolve => eventBus.on("finished", () => resolve()));

      const reqCtx = makeRequestContext("prompt", { targets: ["ava"] });
      await adapter.execute(reqCtx, eventBus);
      await done;

      const failedEvt = collected.find(
        e => e.kind === "status-update" && "status" in e && (e as { status: { state: string } }).status.state === "failed",
      ) as { status: { message?: { parts: Array<{ text?: string }> } } } | undefined;
      expect(failedEvt).toBeDefined();
      const text = failedEvt!.status.message?.parts?.map(p => p.text ?? "").join("") ?? "";
      expect(text).not.toContain("<!DOCTYPE");
      expect(text.toLowerCase()).toContain("downstream agent returned an http error");
    } finally {
      console.warn = origWarn;
    }
  });

  test("cancelTask yields canceled status and unblocks execute()", async () => {
    const bus = new InMemoryEventBus();
    const ctx: ApiContext = {
      workspaceDir: "/tmp",
      bus,
      plugins: [],
      executorRegistry: new ExecutorRegistry(),
    };

    // Never respond — we'll cancel before a reply arrives
    bus.subscribe("agent.skill.request", "test", () => {});

    const adapter = new BusAgentExecutor(ctx);
    const eventBus = new DefaultExecutionEventBus();
    const collected: AgentExecutionEvent[] = [];
    eventBus.on("event", (e) => collected.push(e));

    const reqCtx = makeRequestContext("Will be canceled");
    const executing = adapter.execute(reqCtx, eventBus);

    // Give execute() a tick to subscribe before we cancel
    await new Promise(r => setTimeout(r, 10));
    await adapter.cancelTask(reqCtx.taskId, eventBus);
    await executing;

    const canceledEvt = collected.find(
      e => e.kind === "status-update" && "status" in e && (e as { status: { state: string } }).status.state === "canceled",
    );
    expect(canceledEvt).toBeDefined();
  });
});
