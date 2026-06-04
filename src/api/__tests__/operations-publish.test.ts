/**
 * /publish hardening (#791) — admin auth, explicit topic, control-plane denylist.
 */
import { describe, test, expect } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { createRoutes } from "../operations.ts";
import type { ApiContext, Route } from "../types.ts";

const KEY = "test-admin-key";

function ctxWithKey(bus: InMemoryEventBus): ApiContext {
  return { workspaceDir: "/tmp", bus, plugins: [], executorRegistry: new ExecutorRegistry(), apiKey: KEY };
}
function publishRoute(ctx: ApiContext): Route {
  const r = createRoutes(ctx).find((x) => x.method === "POST" && x.path === "/publish");
  if (!r) throw new Error("no /publish route");
  return r;
}
function req(body: unknown, key?: string): Request {
  return new Request("http://x/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { "X-API-Key": key } : {}) },
    body: JSON.stringify(body),
  });
}

describe("/publish hardening", () => {
  test("401 without the admin key (fails closed when key is configured)", async () => {
    const bus = new InMemoryEventBus();
    const res = await publishRoute(ctxWithKey(bus)).handler(req({ topic: "feature.completed" }), {});
    expect(res.status).toBe(401);
  });

  test("403 on a denied control-plane topic even with the key", async () => {
    const bus = new InMemoryEventBus();
    let saw = false;
    bus.subscribe("agent.skill.request", "t", () => { saw = true; });
    const res = await publishRoute(ctxWithKey(bus)).handler(req({ topic: "agent.skill.request", payload: {} }, KEY), {});
    expect(res.status).toBe(403);
    expect(saw).toBe(false); // never reached the bus
  });

  test("400 when topic is missing (no silent '#' publish)", async () => {
    const bus = new InMemoryEventBus();
    const res = await publishRoute(ctxWithKey(bus)).handler(req({ payload: { x: 1 } }, KEY), {});
    expect(res.status).toBe(400);
  });

  test("publishes an allowed topic with the key", async () => {
    const bus = new InMemoryEventBus();
    const got: unknown[] = [];
    bus.subscribe("feature.completed", "t", (m) => got.push(m.payload));
    const res = await publishRoute(ctxWithKey(bus)).handler(
      req({ topic: "feature.completed", payload: { featureId: "f1" } }, KEY), {},
    );
    expect(res.status).toBe(200);
    expect(got).toEqual([{ featureId: "f1" }]);
  });
});
