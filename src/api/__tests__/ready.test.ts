/**
 * #795 — /ready readiness probe. Gates on local invariants (sqlite); the
 * gateway is reported but does not gate (LLM_GATEWAY_URL unset in tests).
 */
import { describe, test, expect } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { createRoutes } from "../operations.ts";
import type { ApiContext, Route } from "../types.ts";
import type { TelemetryService } from "../../telemetry/telemetry-service.ts";

function readyRoute(ctx: ApiContext): Route {
  const r = createRoutes(ctx).find((x) => x.method === "GET" && x.path === "/ready");
  if (!r) throw new Error("no /ready route");
  return r;
}
function baseCtx(telemetry?: TelemetryService): ApiContext {
  return { workspaceDir: "/tmp", bus: new InMemoryEventBus(), plugins: [], executorRegistry: new ExecutorRegistry(), telemetry };
}
const fakeTelemetry = (healthy: boolean) => ({ healthCheck: () => healthy }) as unknown as TelemetryService;

describe("/ready", () => {
  test("200 ready when sqlite is healthy; gateway 'unconfigured' when LLM_GATEWAY_URL unset", async () => {
    const res = await readyRoute(baseCtx(fakeTelemetry(true))).handler(new Request("http://x/ready"), {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ready");
    expect(body.sqlite).toBe(true);
    expect(body.gateway).toBe("unconfigured");
  });

  test("503 unready when sqlite is down", async () => {
    const res = await readyRoute(baseCtx(fakeTelemetry(false))).handler(new Request("http://x/ready"), {});
    expect(res.status).toBe(503);
    expect((await res.json() as Record<string, unknown>).status).toBe("unready");
  });

  test("200 when no telemetry is wired (sqlite check skipped → assumed ok)", async () => {
    const res = await readyRoute(baseCtx(undefined)).handler(new Request("http://x/ready"), {});
    expect(res.status).toBe(200);
  });
});
