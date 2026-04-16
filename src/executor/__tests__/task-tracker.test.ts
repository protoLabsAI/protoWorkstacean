import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { TaskTracker } from "../task-tracker.ts";
import type { A2AExecutor } from "../executors/a2a-executor.ts";
import type { SkillResult } from "../types.ts";
import { defaultHitlModeRegistry } from "../extensions/hitl-mode.ts";

/** Minimal fake executor that lets tests drive pollTask responses. */
function makeFakeExecutor(responses: SkillResult[] | (() => SkillResult)): A2AExecutor {
  let idx = 0;
  const nextResult = typeof responses === "function"
    ? responses
    : () => responses[Math.min(idx++, responses.length - 1)];
  const fake = {
    type: "a2a" as const,
    execute: async () => ({ text: "", isError: false, correlationId: "" }),
    pollTask: async () => nextResult(),
    cancelTask: async () => ({ text: "canceled", isError: false, correlationId: "" }),
    resubscribeTask: async () => { throw new Error("not used in tests"); },
  };
  // Cast — the tracker only needs pollTask, and A2AExecutor's private fields
  // aren't part of the behavior being tested here.
  return fake as unknown as A2AExecutor;
}

describe("TaskTracker", () => {
  let bus: InMemoryEventBus;
  let tracker: TaskTracker;
  let received: Array<{ topic: string; payload: unknown }>;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    received = [];
    bus.subscribe("agent.skill.response.#", "test-listener", (msg) => {
      received.push({ topic: msg.topic, payload: msg.payload });
    });
  });

  afterEach(() => {
    tracker?.destroy();
  });

  test("publishes response when task reaches terminal state", async () => {
    const executor = makeFakeExecutor([
      { text: "still working", isError: false, correlationId: "c1", data: { taskState: "working", taskId: "t1", contextId: "ctx1" } },
      { text: "all done", isError: false, correlationId: "c1", data: { taskState: "completed", taskId: "t1", contextId: "ctx1" } },
    ]);

    tracker = new TaskTracker({ bus, sweepIntervalMs: 30, defaultPollIntervalMs: 20 });
    tracker.track({
      correlationId: "c1",
      taskId: "t1",
      agentName: "quinn",
      replyTopic: "agent.skill.response.c1",
      executor,
    });

    // First sweep sees "working"; second sees "completed"
    await new Promise(r => setTimeout(r, 90));

    expect(received).toHaveLength(1);
    expect(received[0].topic).toBe("agent.skill.response.c1");
    expect((received[0].payload as { content: string }).content).toBe("all done");
    expect(tracker.size).toBe(0);
  });

  test("surfaces failed state as error response", async () => {
    const executor = makeFakeExecutor([
      { text: "kaboom", isError: true, correlationId: "c1", data: { taskState: "failed", taskId: "t1" } },
    ]);

    tracker = new TaskTracker({ bus, sweepIntervalMs: 20, defaultPollIntervalMs: 10 });
    tracker.track({
      correlationId: "c1", taskId: "t1", agentName: "quinn",
      replyTopic: "agent.skill.response.c1", executor,
    });

    await new Promise(r => setTimeout(r, 60));
    expect(received).toHaveLength(1);
    expect((received[0].payload as { error: string }).error).toBe("kaboom");
    expect(tracker.size).toBe(0);
  });

  test("respects pollIntervalMs — doesn't poll on every sweep", async () => {
    let polls = 0;
    const executor = makeFakeExecutor(() => {
      polls++;
      return { text: "still going", isError: false, correlationId: "c1", data: { taskState: "working", taskId: "t1" } };
    });

    tracker = new TaskTracker({ bus, sweepIntervalMs: 20, defaultPollIntervalMs: 200 });
    tracker.track({
      correlationId: "c1", taskId: "t1", agentName: "quinn",
      replyTopic: "agent.skill.response.c1", executor,
    });

    // 100ms: sweeps run 5 times (20ms each) but poll only fires once (200ms interval)
    await new Promise(r => setTimeout(r, 100));
    expect(polls).toBeLessThanOrEqual(2);
  });

  test("ages out tasks past maxTrackingMs with timeout error", async () => {
    const executor = makeFakeExecutor([
      { text: "still going", isError: false, correlationId: "c1", data: { taskState: "working", taskId: "t1" } },
    ]);

    tracker = new TaskTracker({ bus, sweepIntervalMs: 20, defaultPollIntervalMs: 10, maxTrackingMs: 50 });
    tracker.track({
      correlationId: "c1", taskId: "t1", agentName: "quinn",
      replyTopic: "agent.skill.response.c1", executor,
    });

    await new Promise(r => setTimeout(r, 120));
    expect(received).toHaveLength(1);
    expect((received[0].payload as { error: string }).error).toMatch(/timeout/i);
    expect(tracker.size).toBe(0);
  });

  test("untrack removes task without publishing", async () => {
    const executor = makeFakeExecutor([
      { text: "completed", isError: false, correlationId: "c1", data: { taskState: "completed", taskId: "t1" } },
    ]);

    tracker = new TaskTracker({ bus, sweepIntervalMs: 50, defaultPollIntervalMs: 30 });
    tracker.track({
      correlationId: "c1", taskId: "t1", agentName: "quinn",
      replyTopic: "agent.skill.response.c1", executor,
    });
    tracker.untrack("c1");

    await new Promise(r => setTimeout(r, 80));
    expect(received).toHaveLength(0);
    expect(tracker.size).toBe(0);
  });

  test("concurrent tasks stay isolated", async () => {
    const executor = makeFakeExecutor(() => ({
      text: "done", isError: false, correlationId: "", data: { taskState: "completed", taskId: "t" },
    }));

    tracker = new TaskTracker({ bus, sweepIntervalMs: 20, defaultPollIntervalMs: 10 });
    for (let i = 0; i < 5; i++) {
      tracker.track({
        correlationId: `c${i}`, taskId: `t${i}`, agentName: "quinn",
        replyTopic: `agent.skill.response.c${i}`, executor,
      });
    }

    await new Promise(r => setTimeout(r, 80));
    expect(received).toHaveLength(5);
    const topics = received.map(r => r.topic).sort();
    expect(topics).toEqual([
      "agent.skill.response.c0",
      "agent.skill.response.c1",
      "agent.skill.response.c2",
      "agent.skill.response.c3",
      "agent.skill.response.c4",
    ]);
  });

  test("poll failures don't crash the sweep", async () => {
    const executor = {
      type: "a2a" as const,
      execute: async () => ({ text: "", isError: false, correlationId: "" }),
      pollTask: async () => { throw new Error("network blip"); },
      cancelTask: async () => ({ text: "", isError: false, correlationId: "" }),
      resubscribeTask: async () => { throw new Error("not used"); },
    } as unknown as A2AExecutor;

    tracker = new TaskTracker({ bus, sweepIntervalMs: 20, defaultPollIntervalMs: 10 });
    tracker.track({
      correlationId: "c1", taskId: "t1", agentName: "quinn",
      replyTopic: "agent.skill.response.c1", executor,
    });

    await new Promise(r => setTimeout(r, 80));
    // Task still tracked (no terminal state seen); no response published
    expect(received).toHaveLength(0);
    expect(tracker.size).toBe(1);
  });

  // ── Arc 7.3: compound gated task checkpointing ────────────────────────────
  describe("compound gated checkpointing (Arc 7.3)", () => {
    test("increments checkpoint counter on each input-required cycle", async () => {
      // Fake executor — resumeTask resolves, pollTask alternates input-required
      // and working so the tracker can cycle through checkpoints.
      let pollCalls = 0;
      const fake = {
        type: "a2a" as const,
        execute: async () => ({ text: "", isError: false, correlationId: "" }),
        pollTask: async (): Promise<SkillResult> => {
          pollCalls += 1;
          return pollCalls === 1
            ? { text: "draft needs review", isError: false, correlationId: "c1", data: { taskState: "input-required", taskId: "t1", contextId: "ctx1" } }
            : { text: "final approval?", isError: false, correlationId: "c1", data: { taskState: "input-required", taskId: "t1", contextId: "ctx1" } };
        },
        cancelTask: async () => ({ text: "canceled", isError: false, correlationId: "c1" }),
        resubscribeTask: async () => { throw new Error("not used"); },
        resumeTask: async () => {},
      };
      const executor = fake as unknown as A2AExecutor;

      const requests: unknown[] = [];
      bus.subscribe("hitl.request.#", "test", (msg) => { requests.push(msg.payload); });

      tracker = new TaskTracker({ bus, sweepIntervalMs: 20, defaultPollIntervalMs: 10 });
      tracker.track({
        correlationId: "c1", taskId: "t1", agentName: "ava",
        replyTopic: "agent.skill.response.c1", executor,
        sourceInterface: "discord", sourceChannelId: "chan", sourceUserId: "user",
      });

      // Wait for first input-required → HITL raised
      await new Promise(r => setTimeout(r, 50));
      expect(requests.length).toBe(1);
      expect((requests[0] as { checkpoint?: { index: number } }).checkpoint?.index).toBe(1);
      expect((requests[0] as { title: string }).title).not.toContain("checkpoint");

      // Simulate human decision → triggers resume; tracker clears awaitingHuman
      bus.publish("hitl.response.c1", {
        id: "r1", correlationId: "c1", topic: "hitl.response.c1", timestamp: Date.now(),
        payload: { type: "hitl_response", correlationId: "c1", decision: "approve", decidedBy: "human" },
      });

      // Wait for next sweep cycle → second input-required → second HITL raise
      await new Promise(r => setTimeout(r, 80));
      expect(requests.length).toBe(2);
      expect((requests[1] as { checkpoint?: { index: number } }).checkpoint?.index).toBe(2);
      expect((requests[1] as { title: string }).title).toContain("checkpoint 2");
    });

    test("first checkpoint does not include counter in title", async () => {
      const fake = {
        type: "a2a" as const,
        execute: async () => ({ text: "", isError: false, correlationId: "" }),
        pollTask: async (): Promise<SkillResult> => ({
          text: "please confirm", isError: false, correlationId: "c1",
          data: { taskState: "input-required", taskId: "t1", contextId: "ctx1" },
        }),
        cancelTask: async () => ({ text: "", isError: false, correlationId: "c1" }),
        resubscribeTask: async () => { throw new Error("not used"); },
        resumeTask: async () => {},
      };
      const executor = fake as unknown as A2AExecutor;

      const requests: unknown[] = [];
      bus.subscribe("hitl.request.#", "test", (msg) => { requests.push(msg.payload); });

      tracker = new TaskTracker({ bus, sweepIntervalMs: 20, defaultPollIntervalMs: 10 });
      tracker.track({
        correlationId: "c1", taskId: "t1", agentName: "ava",
        replyTopic: "agent.skill.response.c1", executor,
      });

      await new Promise(r => setTimeout(r, 40));
      expect(requests.length).toBe(1);
      const first = requests[0] as { title: string; checkpoint?: { index: number } };
      expect(first.checkpoint?.index).toBe(1);
      expect(first.title).toBe("Input needed from ava");
      expect(first.title).not.toContain("checkpoint");
    });
  });

  // ── Dispatcher caller-first HITL chain ───────────────────────────────────
  describe("dispatcher caller-first routing", () => {
    afterEach(() => {
      defaultHitlModeRegistry.clear();
    });

    function makeInputRequiredExecutor(): { executor: A2AExecutor; resumedWith: string[] } {
      const resumedWith: string[] = [];
      const fake = {
        type: "a2a" as const,
        execute: async () => ({ text: "", isError: false, correlationId: "" }),
        pollTask: async (): Promise<SkillResult> => ({
          text: "should I ship?", isError: false, correlationId: "c1",
          data: { taskState: "input-required", taskId: "t1", contextId: "ctx1" },
        }),
        cancelTask: async () => ({ text: "", isError: false, correlationId: "c1" }),
        resubscribeTask: async () => { throw new Error("not used"); },
        resumeTask: async (_taskId: string, _contextId: string, text: string) => { resumedWith.push(text); },
      };
      return { executor: fake as unknown as A2AExecutor, resumedWith };
    }

    test("routes input-required to dispatcher when dispatcherAgent set and no operator override", async () => {
      const { executor, resumedWith } = makeInputRequiredExecutor();
      const dispatcherRequests: Array<Record<string, unknown>> = [];
      const hitlRequests: unknown[] = [];
      bus.subscribe("agent.skill.request", "test-dispatcher", (msg) => {
        dispatcherRequests.push(msg.payload as Record<string, unknown>);
      });
      bus.subscribe("hitl.request.#", "test-hitl", (msg) => { hitlRequests.push(msg.payload); });

      tracker = new TaskTracker({ bus, sweepIntervalMs: 20, defaultPollIntervalMs: 10 });
      tracker.track({
        correlationId: "c1", taskId: "t1", agentName: "quinn", skillName: "pr_review",
        dispatcherAgent: "ava",
        replyTopic: "agent.skill.response.c1", executor,
      });

      await new Promise(r => setTimeout(r, 50));
      expect(dispatcherRequests.length).toBe(1);
      expect(dispatcherRequests[0].skill).toBe("chat");
      expect(dispatcherRequests[0].targets).toEqual(["ava"]);
      expect((dispatcherRequests[0].content as string)).toContain("should I ship?");
      expect(hitlRequests).toHaveLength(0);

      // Simulate Ava's chat reply
      const replyTopic = dispatcherRequests[0].replyTopic as string;
      bus.publish(replyTopic, {
        id: "r1", correlationId: "x", topic: replyTopic, timestamp: Date.now(),
        payload: { content: "yes, ship it", isError: false, correlationId: "x" },
      });

      await new Promise(r => setTimeout(r, 30));
      expect(resumedWith).toHaveLength(1);
      expect(resumedWith[0]).toContain("Dispatcher (ava)");
      expect(resumedWith[0]).toContain("yes, ship it");
      expect(hitlRequests).toHaveLength(0);
    });

    test("operator override forces hitl.request despite dispatcher being set", async () => {
      defaultHitlModeRegistry.declare({
        agentName: "quinn", skill: "security_triage",
        mode: "gated", reviewer: "operator",
      });

      const { executor } = makeInputRequiredExecutor();
      const dispatcherRequests: unknown[] = [];
      const hitlRequests: unknown[] = [];
      bus.subscribe("agent.skill.request", "test-dispatcher", (msg) => {
        dispatcherRequests.push(msg.payload);
      });
      bus.subscribe("hitl.request.#", "test-hitl", (msg) => { hitlRequests.push(msg.payload); });

      tracker = new TaskTracker({ bus, sweepIntervalMs: 20, defaultPollIntervalMs: 10 });
      tracker.track({
        correlationId: "c1", taskId: "t1", agentName: "quinn", skillName: "security_triage",
        dispatcherAgent: "ava",
        replyTopic: "agent.skill.response.c1", executor,
      });

      await new Promise(r => setTimeout(r, 50));
      expect(dispatcherRequests).toHaveLength(0);
      expect(hitlRequests).toHaveLength(1);
    });

    test("falls back to hitl.request when dispatcher reply is empty", async () => {
      const { executor } = makeInputRequiredExecutor();
      const dispatcherRequests: Array<Record<string, unknown>> = [];
      const hitlRequests: unknown[] = [];
      bus.subscribe("agent.skill.request", "test-dispatcher", (msg) => {
        dispatcherRequests.push(msg.payload as Record<string, unknown>);
      });
      bus.subscribe("hitl.request.#", "test-hitl", (msg) => { hitlRequests.push(msg.payload); });

      tracker = new TaskTracker({ bus, sweepIntervalMs: 20, defaultPollIntervalMs: 10 });
      tracker.track({
        correlationId: "c1", taskId: "t1", agentName: "quinn", skillName: "pr_review",
        dispatcherAgent: "ava",
        replyTopic: "agent.skill.response.c1", executor,
      });

      await new Promise(r => setTimeout(r, 40));
      expect(dispatcherRequests).toHaveLength(1);

      // Dispatcher replies with empty content — tracker should fall back
      const replyTopic = dispatcherRequests[0].replyTopic as string;
      bus.publish(replyTopic, {
        id: "r1", correlationId: "x", topic: replyTopic, timestamp: Date.now(),
        payload: { content: "", isError: false, correlationId: "x" },
      });

      await new Promise(r => setTimeout(r, 30));
      expect(hitlRequests).toHaveLength(1);
    });
  });
});
