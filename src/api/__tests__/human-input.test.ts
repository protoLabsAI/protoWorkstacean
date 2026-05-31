/**
 * Human-input round-trip (the A2A input-required path). The ask-human endpoint
 * blocks until the caller answers via /api/a2a/input (or the wait window
 * elapses), and publishes the request on the bus so the A2A server can surface
 * an input-required status-update to the caller.
 */

import { describe, test, expect } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { createRoutes, getPendingHumanInput } from "../human-input.ts";
import type { ApiContext, Route } from "../types.ts";
import type { BusMessage } from "../../../lib/types.ts";

function ctxWith(bus: InMemoryEventBus): ApiContext {
  return { workspaceDir: "/tmp", bus, plugins: [], executorRegistry: new ExecutorRegistry() };
}
function route(routes: Route[], path: string): Route {
  const r = routes.find(x => x.method === "POST" && x.path === path);
  if (!r) throw new Error(`route ${path} not found`);
  return r;
}
function post(r: Route, body: unknown): Promise<Response> {
  return r.handler(
    new Request(`http://localhost`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    {},
  ) as Promise<Response>;
}

describe("human-input round-trip", () => {
  test("ask-human blocks, publishes the request, and resolves with the caller's answer", async () => {
    const bus = new InMemoryEventBus();
    const routes = createRoutes(ctxWith(bus));
    const cid = crypto.randomUUID();

    let requestId: string | undefined;
    let questionOnBus: string | undefined;
    bus.subscribe(`agent.input.request.${cid}`, "test", (m: BusMessage) => {
      const p = m.payload as { requestId: string; question: string };
      requestId = p.requestId;
      questionOnBus = p.question;
    });

    // Start the blocking ask (do NOT await yet).
    const askPromise = post(route(routes, "/api/agent/ask-human"), { correlationId: cid, question: "Which repo should I file against?" });

    // The request is announced on the bus and shows up as pending.
    await new Promise(r => setTimeout(r, 10));
    expect(requestId).toBeDefined();
    expect(questionOnBus).toBe("Which repo should I file against?");
    const pendingNow = getPendingHumanInput();
    expect(pendingNow.some(p => p.requestId === requestId && p.correlationId === cid)).toBe(true);

    // Caller answers.
    const ansRes = await post(route(routes, "/api/a2a/input"), { requestId, answer: "protoWorkstacean" });
    expect(((await ansRes.json()) as { success: boolean }).success).toBe(true);

    // The blocked ask now resolves with that answer, and pending is cleared.
    const askBody = (await (await askPromise).json()) as { success: boolean; answer: string };
    expect(askBody).toEqual({ success: true, answer: "protoWorkstacean" });
    expect(getPendingHumanInput().some(p => p.requestId === requestId)).toBe(false);
  });

  test("answering an unknown requestId is a 404; bad input is a 400", async () => {
    const routes = createRoutes(ctxWith(new InMemoryEventBus()));
    const unknown = await post(route(routes, "/api/a2a/input"), { requestId: "nope", answer: "x" });
    expect(unknown.status).toBe(404);

    const bad = await post(route(routes, "/api/agent/ask-human"), { correlationId: "c" }); // missing question
    expect(bad.status).toBe(400);
  });

  test("times out cleanly when no answer arrives within the window", async () => {
    const prev = process.env.A2A_INPUT_REQUIRED_TTL_MS;
    process.env.A2A_INPUT_REQUIRED_TTL_MS = "40";
    try {
      const routes = createRoutes(ctxWith(new InMemoryEventBus()));
      const res = await post(route(routes, "/api/agent/ask-human"), { correlationId: crypto.randomUUID(), question: "anyone there?" });
      const body = (await res.json()) as { success: boolean; timedOut?: boolean; answer: string | null };
      expect(body).toEqual({ success: true, timedOut: true, answer: null });
      expect(getPendingHumanInput().length).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.A2A_INPUT_REQUIRED_TTL_MS;
      else process.env.A2A_INPUT_REQUIRED_TTL_MS = prev;
    }
  });
});
