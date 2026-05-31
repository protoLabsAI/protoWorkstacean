/**
 * /api/discord/progress fans an agent's mid-task update onto the A2A progress
 * bus, not just Discord. This is what lets A2A callers (e.g. ORBIS over /a2a)
 * see intermediate status: the a2a-server bridges agent.skill.progress.{cid}
 * → `working` status-updates on the SSE stream. An A2A conversation has no
 * Discord message behind its correlationId, so a missing Discord message must
 * NOT fail the call.
 */

import { describe, test, expect } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { createRoutes } from "../discord.ts";
import type { ApiContext, Route } from "../types.ts";
import type { BusMessage } from "../../../lib/types.ts";

function progressRoute(ctx: ApiContext): Route {
  const route = createRoutes(ctx).find(
    r => r.method === "POST" && r.path === "/api/discord/progress",
  );
  if (!route) throw new Error("progress route not found");
  return route;
}

function postProgress(route: Route, correlationId: string, content: string): Promise<Response> {
  const req = new Request("http://localhost/api/discord/progress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ correlationId, content }),
  });
  return route.handler(req, {}) as Promise<Response>;
}

describe("/api/discord/progress → A2A progress bus", () => {
  test("publishes agent.skill.progress.{cid} even with no Discord message, and succeeds", async () => {
    const bus = new InMemoryEventBus();
    const ctx: ApiContext = { workspaceDir: "/tmp", bus, plugins: [], executorRegistry: new ExecutorRegistry() };
    const cid = crypto.randomUUID();

    const received: BusMessage[] = [];
    bus.subscribe(`agent.skill.progress.${cid}`, "test", (m) => { received.push(m); });

    const res = await postProgress(progressRoute(ctx), cid, "Quinn is reviewing the PR now");
    const body = (await res.json()) as { success: boolean; delivered?: { bus: boolean; discord: boolean } };

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // No Discord message in pendingReplies for this cid — bus delivered, Discord did not.
    expect(body.delivered).toEqual({ bus: true, discord: false });

    // The progress event reached the bus with the agent's text intact.
    expect(received.length).toBe(1);
    expect((received[0]!.payload as { text: string }).text).toBe("Quinn is reviewing the PR now");
    expect(received[0]!.correlationId).toBe(cid);
  });

  test("still validates input + throttles", async () => {
    const bus = new InMemoryEventBus();
    const ctx: ApiContext = { workspaceDir: "/tmp", bus, plugins: [], executorRegistry: new ExecutorRegistry() };
    const route = progressRoute(ctx);

    // Missing content → 400, nothing published.
    const cid = crypto.randomUUID();
    const bad = await postProgress(route, cid, "");
    expect(bad.status).toBe(400);

    // First update for a fresh cid passes; a second within 5s is throttled (429).
    const cid2 = crypto.randomUUID();
    const first = await postProgress(route, cid2, "first");
    expect(first.status).toBe(200);
    const second = await postProgress(route, cid2, "second");
    expect(second.status).toBe(429);
  });
});
