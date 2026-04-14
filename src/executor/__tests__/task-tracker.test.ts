import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { TaskTracker } from "../task-tracker.ts";
import type { A2AExecutor } from "../executors/a2a-executor.ts";
import type { SkillResult } from "../types.ts";

/** Minimal fake executor that lets tests drive pollTask responses. */
function makeFakeExecutor(
  responses: SkillResult[] | (() => SkillResult),
  onResume?: (taskId: string, contextId: string, text: string) => void,
): A2AExecutor {
  let idx = 0;
  const nextResult = typeof responses === "function"
    ? responses
    : () => responses[Math.min(idx++, responses.length - 1)];
  const fake = {
    type: "a2a" as const,
    execute: async () => ({ text: "", isError: false, correlationId: "" }),
    pollTask: async () => nextResult(),
    resumeTask: async (taskId: string, contextId: string, text: string) => {
      onResume?.(taskId, contextId, text);
    },
    cancelTask: async () => ({ text: "canceled", isError: false, correlationId: "" }),
    resubscribeTask: async () => { throw new Error("not used in tests"); },
  };
  // Cast — the tracker only needs pollTask/resumeTask, and A2AExecutor's private fields
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

  test("compound gated: multiple input-required gates complete sequentially on same task", async () => {
    // Simulates: working → input-required (draft) → working → input-required (review) → completed
    // Each gate gets a HITL request; human approves each; agent continues on same taskId/contextId.
    const resumeCalls: Array<{ taskId: string; contextId: string }> = [];

    let pollIdx = 0;
    const pollSequence: SkillResult[] = [
      { text: "", isError: false, correlationId: "c1", data: { taskState: "working", taskId: "t1", contextId: "ctx1" } },
      { text: "Please approve draft", isError: false, correlationId: "c1", data: { taskState: "input-required", taskId: "t1", contextId: "ctx1" } },
      // After first HITL resume — task goes back to working
      { text: "", isError: false, correlationId: "c1", data: { taskState: "working", taskId: "t1", contextId: "ctx1" } },
      { text: "Please approve review", isError: false, correlationId: "c1", data: { taskState: "input-required", taskId: "t1", contextId: "ctx1" } },
      // After second HITL resume — task completes
      { text: "Published!", isError: false, correlationId: "c1", data: { taskState: "completed", taskId: "t1", contextId: "ctx1" } },
    ];

    const executor = makeFakeExecutor(
      () => pollSequence[Math.min(pollIdx++, pollSequence.length - 1)],
      (taskId, contextId) => resumeCalls.push({ taskId, contextId }),
    );

    const hitlRequests: Array<{ title: string }> = [];
    bus.subscribe("hitl.request.#", "hitl-test", (msg) => {
      hitlRequests.push({ title: (msg.payload as { title: string }).title });
      // Auto-approve: publish hitl response for this request
      const req = msg.payload as { correlationId: string; replyTopic: string };
      setTimeout(() => {
        bus.publish(req.replyTopic, {
          id: crypto.randomUUID(),
          correlationId: req.correlationId,
          topic: req.replyTopic,
          timestamp: Date.now(),
          payload: {
            type: "hitl_response",
            correlationId: req.correlationId,
            decision: "approve",
            decidedBy: "test-human",
          },
        });
      }, 10);
    });

    tracker = new TaskTracker({ bus, sweepIntervalMs: 20, defaultPollIntervalMs: 10 });
    tracker.track({
      correlationId: "c1",
      taskId: "t1",
      contextId: "ctx1",
      agentName: "quinn",
      replyTopic: "agent.skill.response.c1",
      executor,
    });

    await new Promise(r => setTimeout(r, 400));

    // Final response published once
    expect(received).toHaveLength(1);
    expect((received[0].payload as { content: string }).content).toBe("Published!");
    expect(tracker.size).toBe(0);

    // Two HITL gates raised; second has checkpoint label
    expect(hitlRequests).toHaveLength(2);
    expect(hitlRequests[0].title).toBe("Input needed from quinn");
    expect(hitlRequests[1].title).toBe("Input needed from quinn (checkpoint 2)");

    // resumeTask called twice, always with the A2A contextId (not correlationId)
    expect(resumeCalls).toHaveLength(2);
    expect(resumeCalls[0]).toEqual({ taskId: "t1", contextId: "ctx1" });
    expect(resumeCalls[1]).toEqual({ taskId: "t1", contextId: "ctx1" });
  });

  test("contextId from poll is used when resuming after HITL", async () => {
    // contextId is not set at track() time but returned by first poll — must be
    // persisted and used in the resumeTask call.
    const resumeCalls: Array<{ contextId: string }> = [];

    let pollIdx = 0;
    const pollSequence: SkillResult[] = [
      { text: "need input", isError: false, correlationId: "c2", data: { taskState: "input-required", taskId: "t2", contextId: "ctx-from-agent" } },
      { text: "done", isError: false, correlationId: "c2", data: { taskState: "completed", taskId: "t2", contextId: "ctx-from-agent" } },
    ];

    const executor = makeFakeExecutor(
      () => pollSequence[Math.min(pollIdx++, pollSequence.length - 1)],
      (_taskId, contextId) => resumeCalls.push({ contextId }),
    );

    bus.subscribe("hitl.request.#", "hitl-test-2", (msg) => {
      const req = msg.payload as { correlationId: string; replyTopic: string };
      setTimeout(() => {
        bus.publish(req.replyTopic, {
          id: crypto.randomUUID(),
          correlationId: req.correlationId,
          topic: req.replyTopic,
          timestamp: Date.now(),
          payload: { type: "hitl_response", correlationId: req.correlationId, decision: "approve", decidedBy: "test" },
        });
      }, 10);
    });

    tracker = new TaskTracker({ bus, sweepIntervalMs: 20, defaultPollIntervalMs: 10 });
    // Note: no contextId passed to track() — it comes from the poll result
    tracker.track({
      correlationId: "c2",
      taskId: "t2",
      agentName: "ava",
      replyTopic: "agent.skill.response.c2",
      executor,
    });

    await new Promise(r => setTimeout(r, 200));

    expect(received.find(r => r.topic === "agent.skill.response.c2")).toBeTruthy();
    expect(resumeCalls[0].contextId).toBe("ctx-from-agent");
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
});
