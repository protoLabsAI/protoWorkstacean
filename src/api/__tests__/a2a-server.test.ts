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
import { Role, TaskState, type Message, type Part } from "@a2a-js/sdk";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { BusAgentExecutor } from "../a2a-server.ts";
import type { ApiContext } from "../types.ts";
import { parseToolCall } from "@protolabs/a2a";

function makeUserMessage(text: string, metadata: Record<string, unknown> = {}): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId: "",
    taskId: "",
    role: Role.ROLE_USER,
    parts: [{
      content: { $case: "text", value: text },
      metadata: undefined,
      filename: "",
      mediaType: "text/plain",
    }],
    metadata,
    extensions: [],
    referenceTaskIds: [],
  };
}

/** A2A 1.0: read a text Part's value via its `content.$case` discriminator. */
function partText(p: Part): string {
  return p.content?.$case === "text" ? p.content.value : "";
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

    // Events in order: submitted task, working status, completed status.
    const taskEvt = collected.find(e => e.kind === "task");
    const workingEvt = collected.find(e => e.kind === "statusUpdate" && e.data.status?.state === TaskState.TASK_STATE_WORKING);
    const completedEvt = collected.find(e => e.kind === "statusUpdate" && e.data.status?.state === TaskState.TASK_STATE_COMPLETED);
    expect(taskEvt).toBeDefined();
    expect(workingEvt).toBeDefined();
    expect(completedEvt).toBeDefined();

    // A2A 1.0: terminal-ness is the state itself (the `final` flag was removed).
    // The completed status carries the reply content.
    if (completedEvt?.kind !== "statusUpdate") throw new Error("expected statusUpdate");
    expect(completedEvt.data.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const terminalText = (completedEvt.data.status?.message?.parts ?? []).map(partText).join("");
    expect(terminalText).toBe("42");

    // #773: the answer is ALSO emitted as a terminal Artifact (the A2A-canonical
    // result location) so clients reading task.artifacts get it, not only
    // status.message.
    const artifactEvt = collected.find(e => e.kind === "artifactUpdate");
    expect(artifactEvt).toBeDefined();
    if (artifactEvt?.kind !== "artifactUpdate") throw new Error("expected artifactUpdate");
    expect(artifactEvt.data.lastChunk).toBe(true);
    const artifactText = (artifactEvt.data.artifact?.parts ?? []).map(partText).join("");
    expect(artifactText).toBe("42");
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
      e => e.kind === "statusUpdate" && e.data.status?.state === TaskState.TASK_STATE_FAILED,
    );
    expect(failedEvt).toBeDefined();
    if (failedEvt?.kind !== "statusUpdate") throw new Error("expected statusUpdate");
    // Failed is a terminal state — that's the done signal in A2A 1.0.
    expect(failedEvt.data.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    const text = (failedEvt.data.status?.message?.parts ?? []).map(partText).join("");
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
      // Assert on the message content, not the `[a2a-server]` tag: that tag is
      // now the structured-logger component (rendered as a JSON field under the
      // NODE_ENV=production build gate), so matching the literal would be
      // env-dependent. The message text is stable across dev/json formats.
      expect(logCalls.some(l => l.includes("defaulting to helm [ava]"))).toBe(true);
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
        e => e.kind === "statusUpdate" && e.data.status?.state === TaskState.TASK_STATE_FAILED,
      );
      expect(failedEvt).toBeDefined();
      if (failedEvt?.kind !== "statusUpdate") throw new Error("expected statusUpdate");
      expect(failedEvt.data.status?.state).toBe(TaskState.TASK_STATE_FAILED);

      const text = (failedEvt.data.status?.message?.parts ?? []).map(partText).join("");
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
        e => e.kind === "statusUpdate" && e.data.status?.state === TaskState.TASK_STATE_FAILED,
      );
      expect(failedEvt).toBeDefined();
      if (failedEvt?.kind !== "statusUpdate") throw new Error("expected statusUpdate");
      const text = (failedEvt.data.status?.message?.parts ?? []).map(partText).join("");
      expect(text).not.toContain("<!DOCTYPE");
      expect(text.toLowerCase()).toContain("downstream agent returned an http error");
    } finally {
      console.warn = origWarn;
    }
  });

  test("intermediate agent.skill.progress.{cid} events stream as working status-updates (#472 Gap 1)", async () => {
    const bus = new InMemoryEventBus();
    const ctx: ApiContext = {
      workspaceDir: "/tmp",
      bus,
      plugins: [],
      executorRegistry: new ExecutorRegistry(),
    };

    // Mimic a long-running executor: fire 3 progress events with varying
    // shapes (text-only, percent+step, full meta), then publish the final
    // reply.
    bus.subscribe("agent.skill.request", "test", (msg) => {
      const cid = msg.correlationId!;
      const progressTopic = `agent.skill.progress.${cid}`;
      const replyTopic = msg.reply!.topic!;
      setTimeout(() => bus.publish(progressTopic, {
        id: crypto.randomUUID(), correlationId: cid, topic: progressTopic, timestamp: Date.now(),
        payload: { text: "Reading the prompt…" },
      }), 0);
      setTimeout(() => bus.publish(progressTopic, {
        id: crypto.randomUUID(), correlationId: cid, topic: progressTopic, timestamp: Date.now(),
        payload: { percent: 50, step: "thinking" },
      }), 5);
      setTimeout(() => bus.publish(progressTopic, {
        id: crypto.randomUUID(), correlationId: cid, topic: progressTopic, timestamp: Date.now(),
        payload: { text: "Wrapping up…", meta: { tool: "search", model: "claude-opus" } },
      }), 10);
      setTimeout(() => bus.publish(replyTopic, {
        id: crypto.randomUUID(), correlationId: cid, topic: replyTopic, timestamp: Date.now(),
        payload: { content: "done", correlationId: cid },
      }), 15);
    });

    const adapter = new BusAgentExecutor(ctx);
    const eventBus = new DefaultExecutionEventBus();
    const collected: AgentExecutionEvent[] = [];
    eventBus.on("event", (e) => collected.push(e));
    const done = new Promise<void>(resolve => eventBus.on("finished", () => resolve()));

    const reqCtx = makeRequestContext("Long task");
    await adapter.execute(reqCtx, eventBus);
    await done;

    type StatusUpdate = Extract<AgentExecutionEvent, { kind: "statusUpdate" }>;
    const workingEvts = collected.filter(
      (e): e is StatusUpdate =>
        e.kind === "statusUpdate" &&
        e.data.status?.state === TaskState.TASK_STATE_WORKING,
    );

    // Expect: initial "working" (pre-dispatch transition) + 3 progress streams
    // = 4 working status updates. A2A 1.0: "working" is itself the non-terminal
    // signal (the old `final: false` flag was removed), so the state filter is
    // the assertion — every collected event here is a non-terminal working one.
    expect(workingEvts.length).toBe(4);
    expect(workingEvts.every(e => e.data.status?.state === TaskState.TASK_STATE_WORKING)).toBe(true);

    const texts = workingEvts.map(e =>
      (e.data.status?.message?.parts ?? []).map(partText).join(""),
    );
    expect(texts).toContain("Reading the prompt…");
    expect(texts).toContain("Wrapping up…");

    // The percent+step event has no text but its metadata should reach the consumer.
    const metaEvt = workingEvts.find(e => e.data.metadata && (e.data.metadata as { percent?: number }).percent === 50);
    expect(metaEvt).toBeDefined();
    expect((metaEvt!.data.metadata as { step?: string }).step).toBe("thinking");

    // Terminal completed event arrives at the end — its state IS the terminal signal.
    const completedEvt = collected.find(
      (e): e is StatusUpdate =>
        e.kind === "statusUpdate" && e.data.status?.state === TaskState.TASK_STATE_COMPLETED,
    );
    expect(completedEvt).toBeDefined();
    expect(completedEvt!.data.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  test("tool-call-v1 frames stream as artifact-update DataParts (#781)", async () => {
    const bus = new InMemoryEventBus();
    const ctx: ApiContext = {
      workspaceDir: "/tmp",
      bus,
      plugins: [],
      executorRegistry: new ExecutorRegistry(),
    };

    bus.subscribe("agent.skill.request", "test", (msg) => {
      const cid = msg.correlationId!;
      const frameTopic = `agent.skill.toolframe.${cid}`;
      const replyTopic = msg.reply!.topic!;
      setTimeout(() => bus.publish(frameTopic, {
        id: crypto.randomUUID(), correlationId: cid, topic: frameTopic, timestamp: Date.now(),
        payload: { frame: { toolCallId: "c1", name: "get_ci_health", phase: "started", args: { repo: "x" } } },
      }), 0);
      setTimeout(() => bus.publish(frameTopic, {
        id: crypto.randomUUID(), correlationId: cid, topic: frameTopic, timestamp: Date.now(),
        payload: { frame: { toolCallId: "c1", name: "get_ci_health", phase: "completed", result: "green" } },
      }), 5);
      setTimeout(() => bus.publish(replyTopic, {
        id: crypto.randomUUID(), correlationId: cid, topic: replyTopic, timestamp: Date.now(),
        payload: { content: "done", correlationId: cid },
      }), 10);
    });

    const adapter = new BusAgentExecutor(ctx);
    const eventBus = new DefaultExecutionEventBus();
    const collected: AgentExecutionEvent[] = [];
    eventBus.on("event", (e) => collected.push(e));
    const done = new Promise<void>(resolve => eventBus.on("finished", () => resolve()));

    await adapter.execute(makeRequestContext("Tool task"), eventBus);
    await done;

    type ArtifactUpdate = Extract<AgentExecutionEvent, { kind: "artifactUpdate" }>;
    const frames = collected
      .filter((e): e is ArtifactUpdate => e.kind === "artifactUpdate")
      .map(e => parseToolCall(e.data.artifact?.parts ?? []))
      .filter((f): f is NonNullable<typeof f> => Boolean(f));

    // Two tool-call frames (started → completed); the terminal text answer is a
    // separate artifact and carries no tool-call DataPart.
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ toolCallId: "c1", name: "get_ci_health", phase: "started" });
    expect(frames[1]).toMatchObject({ toolCallId: "c1", phase: "completed", result: "green" });
  });

  test("progress events arriving after terminal are silently dropped (no extra status-update)", async () => {
    const bus = new InMemoryEventBus();
    const ctx: ApiContext = {
      workspaceDir: "/tmp",
      bus,
      plugins: [],
      executorRegistry: new ExecutorRegistry(),
    };

    bus.subscribe("agent.skill.request", "test", (msg) => {
      const cid = msg.correlationId!;
      const replyTopic = msg.reply!.topic!;
      const progressTopic = `agent.skill.progress.${cid}`;
      // Reply first, then a late progress event — should be dropped.
      setTimeout(() => bus.publish(replyTopic, {
        id: crypto.randomUUID(), correlationId: cid, topic: replyTopic, timestamp: Date.now(),
        payload: { content: "fast result", correlationId: cid },
      }), 0);
      setTimeout(() => bus.publish(progressTopic, {
        id: crypto.randomUUID(), correlationId: cid, topic: progressTopic, timestamp: Date.now(),
        payload: { text: "late progress, should be ignored" },
      }), 10);
    });

    const adapter = new BusAgentExecutor(ctx);
    const eventBus = new DefaultExecutionEventBus();
    const collected: AgentExecutionEvent[] = [];
    eventBus.on("event", (e) => collected.push(e));
    const done = new Promise<void>(resolve => eventBus.on("finished", () => resolve()));

    await adapter.execute(makeRequestContext("Quick"), eventBus);
    await done;
    // Give the late progress event a tick to fire (it shouldn't reach the consumer).
    await new Promise(r => setTimeout(r, 30));

    const lateEvt = collected.find(e =>
      e.kind === "statusUpdate" &&
      (e.data.status?.message?.parts ?? []).some(p => partText(p) === "late progress, should be ignored"),
    );
    expect(lateEvt).toBeUndefined();
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
      e => e.kind === "statusUpdate" && e.data.status?.state === TaskState.TASK_STATE_CANCELED,
    );
    expect(canceledEvt).toBeDefined();
  });

  test("emits periodic working heartbeats while awaiting a slow terminal result (keeps SSE alive)", async () => {
    // The real failure mode: a long in-process turn emits no events between the
    // initial `working` and the terminal status, so an idle-timeout proxy cuts
    // the SSE stream. With a low heartbeat interval and a delayed reply, the
    // adapter should emit ≥1 intermediate `working` heartbeat before terminal.
    const prev = process.env.A2A_STREAM_HEARTBEAT_MS;
    process.env.A2A_STREAM_HEARTBEAT_MS = "20";
    try {
      const bus = new InMemoryEventBus();
      const ctx: ApiContext = {
        workspaceDir: "/tmp",
        bus,
        plugins: [],
        executorRegistry: new ExecutorRegistry(),
      };

      // Reply only after ~90ms — long enough for several 20ms heartbeats — and
      // emit no progress events of our own, mimicking a silent DeepAgent turn.
      bus.subscribe("agent.skill.request", "test", (msg) => {
        const cid = msg.correlationId!;
        const replyTopic = msg.reply!.topic!;
        setTimeout(() => bus.publish(replyTopic, {
          id: crypto.randomUUID(), correlationId: cid, topic: replyTopic, timestamp: Date.now(),
          payload: { content: "slow result", correlationId: cid },
        }), 90);
      });

      const adapter = new BusAgentExecutor(ctx);
      const eventBus = new DefaultExecutionEventBus();
      const collected: AgentExecutionEvent[] = [];
      eventBus.on("event", (e) => collected.push(e));
      const done = new Promise<void>(resolve => eventBus.on("finished", () => resolve()));

      await adapter.execute(makeRequestContext("Slow silent task"), eventBus);
      await done;

      type StatusUpdate = Extract<AgentExecutionEvent, { kind: "statusUpdate" }>;
      const workingEvts = collected.filter(
        (e): e is StatusUpdate =>
          e.kind === "statusUpdate" &&
          e.data.status?.state === TaskState.TASK_STATE_WORKING,
      );
      // We emit no progress of our own, so every `working` beyond the initial
      // pre-dispatch transition is a heartbeat. Expect ≥2 (initial + ≥1 beat).
      // A2A 1.0: "working" is the non-terminal state, so every event here is
      // non-terminal by construction (the `final: false` flag was removed).
      expect(workingEvts.length).toBeGreaterThanOrEqual(2);
      expect(workingEvts.every(e => e.data.status?.state === TaskState.TASK_STATE_WORKING)).toBe(true);

      // Heartbeats stop once settled — no `working` update after the terminal
      // completed event (the interval is cleared and guarded by `settled`).
      const completedIdx = collected.findIndex(
        e => e.kind === "statusUpdate" && e.data.status?.state === TaskState.TASK_STATE_COMPLETED,
      );
      const workingAfterTerminal = collected.slice(completedIdx + 1).some(
        e => e.kind === "statusUpdate" && e.data.status?.state === TaskState.TASK_STATE_WORKING,
      );
      expect(workingAfterTerminal).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.A2A_STREAM_HEARTBEAT_MS;
      else process.env.A2A_STREAM_HEARTBEAT_MS = prev;
    }
  });

  test("agent.input.request.{cid} surfaces as an input-required status-update (question + requestId), then completes", async () => {
    const bus = new InMemoryEventBus();
    const ctx: ApiContext = {
      workspaceDir: "/tmp",
      bus,
      plugins: [],
      executorRegistry: new ExecutorRegistry(),
    };

    const requestId = crypto.randomUUID();
    bus.subscribe("agent.skill.request", "test", (msg) => {
      const cid = msg.correlationId!;
      const replyTopic = msg.reply!.topic!;
      // Mimic the ask_human round-trip: the agent asks mid-task, then (after the
      // caller "answers" out of band) the skill completes.
      setTimeout(() => bus.publish(`agent.input.request.${cid}`, {
        id: crypto.randomUUID(), correlationId: cid, topic: `agent.input.request.${cid}`, timestamp: Date.now(),
        payload: { requestId, question: "Which repo should I file against?" },
      }), 5);
      setTimeout(() => bus.publish(replyTopic, {
        id: crypto.randomUUID(), correlationId: cid, topic: replyTopic, timestamp: Date.now(),
        payload: { content: "Filed against protoWorkstacean.", correlationId: cid },
      }), 20);
    });

    const adapter = new BusAgentExecutor(ctx);
    const eventBus = new DefaultExecutionEventBus();
    const collected: AgentExecutionEvent[] = [];
    eventBus.on("event", (e) => collected.push(e));
    const done = new Promise<void>(resolve => eventBus.on("finished", () => resolve()));

    await adapter.execute(makeRequestContext("Help me file an issue"), eventBus);
    await done;

    type StatusUpdate = Extract<AgentExecutionEvent, { kind: "statusUpdate" }>;

    // input-required event carries the question text + the requestId. A2A 1.0:
    // input-required is an interrupted (non-terminal) state — the task is parked,
    // not settled — and that state itself is the signal (the `final` flag is gone).
    const inputReq = collected.find(
      (e): e is StatusUpdate => e.kind === "statusUpdate" && e.data.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED,
    );
    expect(inputReq).toBeDefined();
    expect(inputReq!.data.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(partText(inputReq!.data.status!.message!.parts[0]!)).toBe("Which repo should I file against?");
    expect(inputReq!.data.status?.message?.metadata?.requestId).toBe(requestId);

    // The task still reaches a terminal completed once the reply lands.
    const completed = collected.find(
      (e): e is StatusUpdate => e.kind === "statusUpdate" && e.data.status?.state === TaskState.TASK_STATE_COMPLETED,
    );
    expect(completed).toBeDefined();
    expect(completed!.data.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });
});
