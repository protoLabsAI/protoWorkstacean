/**
 * #793 — TaskTracker durability: persist on track, delete on terminal,
 * rehydrate-and-resume after restart, escalate the unresolvable.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import type { BusMessage } from "../../../lib/types.ts";
import { TaskTracker } from "../task-tracker.ts";
import { TaskTrackerStore } from "../task-tracker-store.ts";
import type { A2AExecutor } from "../executors/a2a-executor.ts";

let dir: string;
let dbPath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tasktracker-")); dbPath = join(dir, "tasks.db"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Fake A2A executor whose poll returns a terminal completed result. */
function fakeExecutor(): A2AExecutor {
  return {
    pollTask: async () => ({ data: { taskState: "completed", artifacts: [] }, text: "done!", isError: false }),
    recordTerminalExtensions: async () => {},
  } as unknown as A2AExecutor;
}

describe("TaskTrackerStore round-trip", () => {
  test("upsert → loadAll → delete", () => {
    const store = new TaskTrackerStore(dbPath);
    store.upsert({ correlationId: "c1", taskId: "t1", agentName: "roxy", replyTopic: "r1", registeredAt: 100, pollIntervalMs: 30000, callbackToken: "tok" });
    const rows = store.loadAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ correlationId: "c1", taskId: "t1", agentName: "roxy", replyTopic: "r1", callbackToken: "tok" });
    store.delete("c1");
    expect(store.loadAll()).toHaveLength(0);
    store.close();
  });
});

describe("TaskTracker persistence", () => {
  test("track() persists; a terminal callback removes it from the store", () => {
    const store = new TaskTrackerStore(dbPath);
    const tracker = new TaskTracker({ bus: new InMemoryEventBus(), store });
    tracker.track({ correlationId: "c2", taskId: "t2", agentName: "roxy", replyTopic: "agent.skill.response.c2", executor: {} as unknown as A2AExecutor });
    expect(store.loadAll().map((r) => r.correlationId)).toEqual(["c2"]);
    tracker.handleCallback("c2", { status: { state: "completed" }, artifacts: [] });
    expect(store.loadAll()).toHaveLength(0);
    store.close();
  });

  test("rehydrates a persisted task after restart and resumes polling to completion", async () => {
    // Pre-seed the store as if a prior process tracked a task then died.
    const seed = new TaskTrackerStore(dbPath);
    seed.upsert({ correlationId: "c3", taskId: "t3", agentName: "roxy", skillName: "unblock_feature", replyTopic: "agent.skill.response.c3", registeredAt: Date.now(), pollIntervalMs: 30000 });
    seed.close();

    const bus = new InMemoryEventBus();
    const replies: BusMessage[] = [];
    bus.subscribe("agent.skill.response.c3", "t", (m) => { replies.push(m); });
    const store = new TaskTrackerStore(dbPath);
    const tracker = new TaskTracker({ bus, store, resolveExecutor: () => fakeExecutor() });

    await (tracker as unknown as { _sweep: () => Promise<void> })._sweep();

    expect(replies).toHaveLength(1);
    expect((replies[0].payload as Record<string, unknown>).content).toBe("done!");
    expect(store.loadAll()).toHaveLength(0); // forgotten after terminal
    store.close();
  });

  test("escalates (not drops) a rehydrated task whose executor never re-registers", async () => {
    const seed = new TaskTrackerStore(dbPath);
    seed.upsert({ correlationId: "c4", taskId: "t4", agentName: "gone", replyTopic: "agent.skill.response.c4", registeredAt: Date.now(), pollIntervalMs: 30000 });
    seed.close();

    const bus = new InMemoryEventBus();
    const replies: BusMessage[] = [];
    bus.subscribe("agent.skill.response.c4", "t", (m) => { replies.push(m); });
    const store = new TaskTrackerStore(dbPath);
    // resolver returns undefined (agent gone) + zero grace → escalate immediately.
    const tracker = new TaskTracker({ bus, store, resolveExecutor: () => undefined, rehydrateGraceMs: 0 });

    await (tracker as unknown as { _sweep: () => Promise<void> })._sweep();

    expect(replies).toHaveLength(1);
    const p = replies[0].payload as Record<string, unknown>;
    expect(p.taskState).toBe("failed");
    expect(String(p.error)).toContain("interrupted");
    expect(store.loadAll()).toHaveLength(0);
    store.close();
  });
});
