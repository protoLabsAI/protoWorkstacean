/**
 * Integration test for GET /api/widgets
 *
 * Verifies:
 * - Returns all WidgetDescriptors from plugins that implement getWidgets()
 * - Plugins without getWidgets() are silently skipped
 * - Response includes cache-control header
 * - API key validation rejects unauthorized requests
 * - Cache is returned on repeated requests within TTL
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { createRoutes } from "../widgets.ts";
import type { ApiContext } from "../types.ts";
import type { Plugin, WidgetDescriptor } from "../../../lib/types.ts";

function makePlugin(name: string, widgets?: WidgetDescriptor[]): Plugin {
  return {
    name,
    description: "test plugin",
    capabilities: [],
    install() {},
    uninstall() {},
    ...(widgets !== undefined ? { getWidgets: () => widgets } : {}),
  };
}

function makeCtx(plugins: Plugin[], apiKey?: string): ApiContext {
  return {
    workspaceDir: "/tmp",
    bus: new InMemoryEventBus(),
    plugins,
    executorRegistry: new ExecutorRegistry(),
    apiKey,
  };
}

describe("GET /api/widgets", () => {
  test("returns empty array when no plugins have getWidgets", async () => {
    const ctx = makeCtx([makePlugin("plain")]);
    const [route] = createRoutes(ctx);
    const resp = await route.handler(new Request("http://x/api/widgets"), {});
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toEqual([]);
  });

  test("aggregates widgets from all plugins with getWidgets", async () => {
    // Plugin-supplied widgets — pluginName is stamped by discovery from plugin.name
    const w1: WidgetDescriptor = { pluginName: "", id: "w1", type: "chart", title: "Chart A", props: { color: "blue" } };
    const w2: WidgetDescriptor = { pluginName: "", id: "w2", type: "table", title: "Table B" };
    const ctx = makeCtx([
      makePlugin("a", [w1]),
      makePlugin("b", [w2]),
      makePlugin("c"),
    ]);
    const [route] = createRoutes(ctx);
    const resp = await route.handler(new Request("http://x/api/widgets"), {});
    const body = await resp.json() as WidgetDescriptor[];
    expect(body).toHaveLength(2);
    expect(body.map(w => w.id).sort()).toEqual(["w1", "w2"]);
    // Discovery stamps pluginName from plugin.name
    expect(body.find(w => w.id === "w1")?.pluginName).toBe("a");
    expect(body.find(w => w.id === "w2")?.pluginName).toBe("b");
  });

  test("skips plugins without getWidgets gracefully", async () => {
    const w: WidgetDescriptor = { pluginName: "", id: "w1", type: "status-card", title: "Card" };
    const ctx = makeCtx([makePlugin("noWidgets"), makePlugin("hasWidgets", [w])]);
    const [route] = createRoutes(ctx);
    const resp = await route.handler(new Request("http://x/api/widgets"), {});
    const body = await resp.json() as WidgetDescriptor[];
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("w1");
    expect(body[0].pluginName).toBe("hasWidgets");
  });

  test("includes cache-control header with 5s max-age", async () => {
    const ctx = makeCtx([]);
    const [route] = createRoutes(ctx);
    const resp = await route.handler(new Request("http://x/api/widgets"), {});
    expect(resp.headers.get("cache-control")).toContain("max-age=5");
  });

  test("returns 401 when API key is required and missing", async () => {
    const ctx = makeCtx([], "secret-key");
    const [route] = createRoutes(ctx);
    const resp = await route.handler(new Request("http://x/api/widgets"), {});
    expect(resp.status).toBe(401);
  });

  test("returns 401 when API key is wrong", async () => {
    const ctx = makeCtx([], "secret-key");
    const [route] = createRoutes(ctx);
    const resp = await route.handler(
      new Request("http://x/api/widgets", { headers: { "X-API-Key": "wrong" } }),
      {}
    );
    expect(resp.status).toBe(401);
  });

  test("succeeds with correct API key", async () => {
    const ctx = makeCtx([], "secret-key");
    const [route] = createRoutes(ctx);
    const resp = await route.handler(
      new Request("http://x/api/widgets", { headers: { "X-API-Key": "secret-key" } }),
      {}
    );
    expect(resp.status).toBe(200);
  });

  test("cache returns same result on second request within TTL", async () => {
    let callCount = 0;
    const plugin = makePlugin("counter", []);
    const origGetWidgets = plugin.getWidgets!;
    plugin.getWidgets = () => {
      callCount++;
      return origGetWidgets();
    };
    const ctx = makeCtx([plugin]);
    const [route] = createRoutes(ctx);
    await route.handler(new Request("http://x/api/widgets"), {});
    await route.handler(new Request("http://x/api/widgets"), {});
    // getWidgets should only have been called once (cache hit on second request)
    expect(callCount).toBe(1);
  });
});
