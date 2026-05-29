import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { createRoutes } from "../ava-tools.ts";
import type { ApiContext } from "../types.ts";
import type { AgentSkillRequestPayload } from "../../event-bus/payloads.ts";

type Handler = (req: Request, params: Record<string, string>) => Promise<Response> | Response;

function routesFor(ctx: Partial<ApiContext> & { bus: InMemoryEventBus }) {
  const routes = createRoutes(ctx as unknown as ApiContext);
  const chat = routes.find((r) => r.path === "/api/a2a/chat")!.handler as Handler;
  const poll = routes.find((r) => r.path === "/api/a2a/task/:correlationId")!.handler as Handler;
  const delegate = routes.find((r) => r.path === "/api/a2a/delegate")!.handler as Handler;
  return { chat, poll, delegate };
}

/** Registry that resolves an executor for `agent` (or nothing if unknown). */
function fakeRegistry(knownAgents: string[]) {
  return {
    resolve: (_skill: string, targets: string[]) =>
      targets.some((t) => knownAgents.includes(t)) ? ({ type: "a2a" } as unknown) : undefined,
  } as unknown as ApiContext["executorRegistry"];
}

/** A stand-in dispatcher: on each agent.skill.request, publish a terminal reply. */
function autoReply(
  bus: InMemoryEventBus,
  build: (req: AgentSkillRequestPayload, correlationId: string) => Record<string, unknown>,
) {
  bus.subscribe("agent.skill.request", "test-dispatcher", (msg) => {
    const payload = (msg.payload ?? {}) as AgentSkillRequestPayload;
    const correlationId = msg.correlationId;
    const replyPayload = build(payload, correlationId);
    bus.publish(`agent.skill.response.${correlationId}`, {
      id: crypto.randomUUID(),
      correlationId,
      topic: `agent.skill.response.${correlationId}`,
      timestamp: Date.now(),
      payload: { correlationId, ...replyPayload },
    });
  });
}

describe("/api/a2a/chat (bus round-trip)", () => {
  let bus: InMemoryEventBus;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    delete process.env.A2A_CHAT_REPLY_TIMEOUT_MS;
  });
  afterEach(() => {
    delete process.env.A2A_CHAT_REPLY_TIMEOUT_MS;
  });

  test("returns the agent's real terminal output, not a submit-ack stub", async () => {
    let seen: AgentSkillRequestPayload | undefined;
    autoReply(bus, (req) => {
      seen = req;
      return { content: "the genuine answer", taskState: "completed", taskId: "task-123" };
    });
    const { chat } = routesFor({ bus, executorRegistry: fakeRegistry(["protopen"]) });

    const resp = await chat(
      new Request("http://x/api/a2a/chat", {
        method: "POST",
        body: JSON.stringify({ agent: "protopen", skill: "threat_intel", message: "ping", contextId: "conv-1" }),
      }),
      {},
    );
    const json = (await resp.json()) as { success: boolean; data: Record<string, unknown> };

    expect(resp.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.response).toBe("the genuine answer");
    expect(json.data.taskState).toBe("completed");
    expect(json.data.taskId).toBe("task-123");
    // contextId continuity: the dispatched request carried our contextId, and
    // the response echoes it.
    expect(seen?.contextId).toBe("conv-1");
    expect(json.data.contextId).toBe("conv-1");
  });

  test("maps an error reply to a non-200 with the error text", async () => {
    autoReply(bus, () => ({ error: "boom on the agent side", taskState: "failed" }));
    const { chat } = routesFor({ bus, executorRegistry: fakeRegistry(["protopen"]) });

    const resp = await chat(
      new Request("http://x/api/a2a/chat", {
        method: "POST",
        body: JSON.stringify({ agent: "protopen", message: "ping" }),
      }),
      {},
    );
    const json = (await resp.json()) as { success: boolean; error: string };
    expect(resp.status).toBe(502);
    expect(json.success).toBe(false);
    expect(json.error).toBe("boom on the agent side");
  });

  test("returns pending + pollUrl when the terminal result doesn't arrive in time", async () => {
    process.env.A2A_CHAT_REPLY_TIMEOUT_MS = "40"; // no autoReply → guaranteed timeout
    const { chat } = routesFor({ bus, executorRegistry: fakeRegistry(["protopen"]) });

    const resp = await chat(
      new Request("http://x/api/a2a/chat", {
        method: "POST",
        body: JSON.stringify({ agent: "protopen", skill: "active_pentest", message: "long task" }),
      }),
      {},
    );
    const json = (await resp.json()) as { success: boolean; data: Record<string, unknown> };
    expect(resp.status).toBe(200);
    expect(json.data.pending).toBe(true);
    expect(json.data.response).toBeNull();
    expect(json.data.taskState).toBe("working");
    expect(json.data.pollUrl).toBe(`/api/a2a/task/${json.data.correlationId}`);
  });

  test("404 when no executor is registered for the agent", async () => {
    const { chat } = routesFor({ bus, executorRegistry: fakeRegistry([]) });
    const resp = await chat(
      new Request("http://x/api/a2a/chat", {
        method: "POST",
        body: JSON.stringify({ agent: "ghost", message: "ping" }),
      }),
      {},
    );
    expect(resp.status).toBe(404);
  });
});

describe("/api/a2a/task/:correlationId (poll)", () => {
  test("returns the cached terminal result when present", async () => {
    const bus = new InMemoryEventBus();
    const taskTracker = {
      getResult: (id: string) =>
        id === "c-done" ? { content: "finished output", taskState: "completed", correlationId: id, taskId: "t9" } : undefined,
      getAll: () => [{ correlationId: "c-working", taskId: "t1", agentName: "protopen" }],
    } as unknown as ApiContext["taskTracker"];
    const { poll } = routesFor({ bus, executorRegistry: fakeRegistry(["protopen"]), taskTracker });

    const done = await poll(new Request("http://x/api/a2a/task/c-done"), { correlationId: "c-done" });
    const dj = (await done.json()) as { data: Record<string, unknown> };
    expect(dj.data.done).toBe(true);
    expect(dj.data.response).toBe("finished output");

    const working = await poll(new Request("http://x/api/a2a/task/c-working"), { correlationId: "c-working" });
    const wj = (await working.json()) as { data: Record<string, unknown> };
    expect(wj.data.pending).toBe(true);
    expect(wj.data.taskState).toBe("working");

    const unknown = await poll(new Request("http://x/api/a2a/task/c-nope"), { correlationId: "c-nope" });
    const uj = (await unknown.json()) as { data: Record<string, unknown> };
    expect(uj.data.taskState).toBe("unknown");
  });
});
