import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { TaskTracker } from "../../executor/task-tracker.ts";
import type { A2AExecutor } from "../../executor/executors/a2a-executor.ts";
import { createRoutes } from "../a2a-callback.ts";
import type { ApiContext } from "../types.ts";

function fakeExecutor(): A2AExecutor {
  return {
    type: "a2a",
    execute: async () => ({ text: "", isError: false, correlationId: "" }),
    pollTask: async () => ({ text: "", isError: false, correlationId: "", data: { taskState: "working" } }),
    cancelTask: async () => ({ text: "", isError: false, correlationId: "" }),
    resubscribeTask: async () => { throw new Error("not used"); },
    registerPushNotification: async () => false,
  } as unknown as A2AExecutor;
}

describe("/api/a2a/callback/:taskId", () => {
  let bus: InMemoryEventBus;
  let tracker: TaskTracker;
  let handler: (req: Request, params: Record<string, string>) => Promise<Response> | Response;
  let received: Array<{ topic: string; payload: unknown }>;
  const ctx = { taskTracker: undefined } as unknown as ApiContext;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    received = [];
    bus.subscribe("agent.skill.response.#", "test", (msg) => {
      received.push({ topic: msg.topic, payload: msg.payload });
    });
    tracker = new TaskTracker({ bus, sweepIntervalMs: 60_000, defaultPollIntervalMs: 60_000 });
    const routes = createRoutes(tracker, ctx);
    const route = routes[0];
    handler = route.handler;
  });

  afterEach(() => {
    tracker.destroy();
  });

  test("404 for unknown taskId", async () => {
    const req = new Request("http://x/api/a2a/callback/unknown", { method: "POST", body: "{}" });
    const resp = await handler(req, { taskId: "unknown" });
    expect(resp.status).toBe(404);
  });

  test("401 when token missing or wrong", async () => {
    tracker.track({
      correlationId: "c1", taskId: "t1", agentName: "quinn",
      replyTopic: "agent.skill.response.c1", executor: fakeExecutor(), callbackToken: "secret",
    });

    // No token
    const r1 = await handler(
      new Request("http://x/api/a2a/callback/t1", { method: "POST", body: JSON.stringify({}) }),
      { taskId: "t1" },
    );
    expect(r1.status).toBe(401);

    // Wrong token
    const r2 = await handler(
      new Request("http://x/api/a2a/callback/t1", {
        method: "POST",
        headers: { "x-a2a-notification-token": "wrong" },
        body: JSON.stringify({}),
      }),
      { taskId: "t1" },
    );
    expect(r2.status).toBe(401);
  });

  test("200 + publishes response on terminal Task callback (via X-A2A-Notification-Token)", async () => {
    tracker.track({
      correlationId: "c1", taskId: "t1", agentName: "quinn",
      replyTopic: "agent.skill.response.c1", executor: fakeExecutor(), callbackToken: "secret",
    });

    const body = {
      id: "t1",
      kind: "task",
      status: { state: "completed" },
      artifacts: [{ artifactId: "a1", parts: [{ kind: "text", text: "all good" }] }],
    };
    const resp = await handler(
      new Request("http://x/api/a2a/callback/t1", {
        method: "POST",
        headers: { "x-a2a-notification-token": "secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { taskId: "t1" },
    );
    expect(resp.status).toBe(200);
    expect(received).toHaveLength(1);
    expect((received[0].payload as { content: string }).content).toBe("all good");
    expect(tracker.size).toBe(0);
  });

  test("accepts Bearer token as alternative", async () => {
    tracker.track({
      correlationId: "c1", taskId: "t1", agentName: "quinn",
      replyTopic: "agent.skill.response.c1", executor: fakeExecutor(), callbackToken: "secret",
    });

    const body = { id: "t1", kind: "task", status: { state: "completed" } };
    const resp = await handler(
      new Request("http://x/api/a2a/callback/t1", {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { taskId: "t1" },
    );
    expect(resp.status).toBe(200);
  });

  test("non-terminal callback just updates lastPolledAt, no publish", async () => {
    tracker.track({
      correlationId: "c1", taskId: "t1", agentName: "quinn",
      replyTopic: "agent.skill.response.c1", executor: fakeExecutor(), callbackToken: "secret",
    });

    const body = { id: "t1", kind: "task", status: { state: "working" } };
    const resp = await handler(
      new Request("http://x/api/a2a/callback/t1", {
        method: "POST",
        headers: { "x-a2a-notification-token": "secret" },
        body: JSON.stringify(body),
      }),
      { taskId: "t1" },
    );
    expect(resp.status).toBe(200);
    expect(received).toHaveLength(0);
    expect(tracker.size).toBe(1);
  });

  test("failed state surfaces as error in published response", async () => {
    tracker.track({
      correlationId: "c1", taskId: "t1", agentName: "quinn",
      replyTopic: "agent.skill.response.c1", executor: fakeExecutor(), callbackToken: "secret",
    });

    const body = {
      id: "t1", kind: "task",
      status: { state: "failed", message: { parts: [{ kind: "text", text: "kaboom" }] } },
    };
    await handler(
      new Request("http://x/api/a2a/callback/t1", {
        method: "POST",
        headers: { "x-a2a-notification-token": "secret" },
        body: JSON.stringify(body),
      }),
      { taskId: "t1" },
    );
    expect(received).toHaveLength(1);
    expect((received[0].payload as { error: string }).error).toBe("kaboom");
  });
});
