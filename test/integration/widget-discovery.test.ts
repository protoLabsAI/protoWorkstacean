/**
 * Integration test: widget discovery full flow.
 *
 * Verifies end-to-end behaviour of the /api/widgets discovery pipeline:
 * - 3+ plugins loaded, all declared widgets discovered
 * - Dashboard receives all widgets (simulated via route response)
 * - Performance: response assembles <50ms with 10 plugins
 * - Plugins without getWidgets() are silently skipped (backward compat)
 */

import { describe, test, expect } from "bun:test";
import { InMemoryEventBus } from "../../lib/bus.ts";
import { ExecutorRegistry } from "../../src/executor/executor-registry.ts";
import { createRoutes } from "../../src/api/widgets.ts";
import type { ApiContext } from "../../src/api/types.ts";
import type { Plugin, WidgetDescriptor, EventBus } from "../../lib/types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePlugin(name: string, widgets?: WidgetDescriptor[]): Plugin {
  return {
    name,
    description: `${name} plugin`,
    capabilities: [],
    install(_bus: EventBus) {},
    uninstall() {},
    ...(widgets !== undefined ? { getWidgets: () => widgets } : {}),
  };
}

function makeCtx(plugins: Plugin[]): ApiContext {
  return {
    workspaceDir: "/tmp",
    bus: new InMemoryEventBus(),
    plugins,
    executorRegistry: new ExecutorRegistry(),
  };
}

// ── Widget fixture factories ──────────────────────────────────────────────────

function worldStateWidgets(): WidgetDescriptor[] {
  return [
    {
      pluginName: "",
      id: "world-state-domain-grid",
      type: "table",
      title: "Domain Grid",
      query: "/api/world-state",
      props: { layout: "grid" },
    },
    {
      pluginName: "",
      id: "world-state-domain-card",
      type: "status-card",
      title: "Domain Card",
      query: "/api/world-state",
      props: { layout: "card" },
    },
  ];
}

function eventStreamWidgets(): WidgetDescriptor[] {
  return [
    {
      pluginName: "",
      id: "event-stream",
      type: "log-stream",
      title: "Event Stream",
      query: "/api/events",
      props: { wsPath: "/ws", limit: 500 },
    },
  ];
}

function metricsWidgets(): WidgetDescriptor[] {
  return [
    {
      pluginName: "",
      id: "fleet-cost-chart",
      type: "chart",
      title: "Fleet Cost",
      query: "/api/fleet-cost",
      props: { unit: "USD" },
    },
    {
      pluginName: "",
      id: "agent-status-table",
      type: "table",
      title: "Agent Status",
      query: "/api/agents",
    },
  ];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Widget discovery integration", () => {
  test("discovers all widgets from 3+ plugins", async () => {
    const plugins: Plugin[] = [
      makePlugin("world-state-engine", worldStateWidgets()),
      makePlugin("event-viewer", eventStreamWidgets()),
      makePlugin("fleet-metrics", metricsWidgets()),
    ];

    const ctx = makeCtx(plugins);
    const [route] = createRoutes(ctx);
    const resp = await route.handler(new Request("http://localhost/api/widgets"), {});

    expect(resp.status).toBe(200);

    const body = (await resp.json()) as WidgetDescriptor[];

    // All 5 widgets discovered
    expect(body).toHaveLength(5);

    // Every widget has pluginName stamped
    for (const w of body) {
      expect(w.pluginName).toBeTruthy();
      expect(w.id).toBeTruthy();
      expect(w.type).toBeTruthy();
      expect(w.title).toBeTruthy();
    }

    // Correct plugin attribution
    const worldWidgets = body.filter((w) => w.pluginName === "world-state-engine");
    expect(worldWidgets).toHaveLength(2);
    expect(worldWidgets.map((w) => w.id).sort()).toEqual([
      "world-state-domain-card",
      "world-state-domain-grid",
    ]);

    const eventWidgets = body.filter((w) => w.pluginName === "event-viewer");
    expect(eventWidgets).toHaveLength(1);
    expect(eventWidgets[0].id).toBe("event-stream");
    expect(eventWidgets[0].type).toBe("log-stream");

    const metricsWidgets_ = body.filter((w) => w.pluginName === "fleet-metrics");
    expect(metricsWidgets_).toHaveLength(2);
  });

  test("dashboard widget set covers all expected widget types", async () => {
    const plugins: Plugin[] = [
      makePlugin("world-state-engine", worldStateWidgets()),
      makePlugin("event-viewer", eventStreamWidgets()),
      makePlugin("fleet-metrics", metricsWidgets()),
    ];

    const ctx = makeCtx(plugins);
    const [route] = createRoutes(ctx);
    const resp = await route.handler(new Request("http://localhost/api/widgets"), {});
    const body = (await resp.json()) as WidgetDescriptor[];

    const types = new Set(body.map((w) => w.type));
    expect(types.has("table")).toBe(true);
    expect(types.has("status-card")).toBe(true);
    expect(types.has("log-stream")).toBe(true);
    expect(types.has("chart")).toBe(true);
  });

  test("performance: /api/widgets assembles <50ms with 10 plugins", async () => {
    const plugins: Plugin[] = Array.from({ length: 10 }, (_, i) =>
      makePlugin(`plugin-${i}`, [
        {
          pluginName: "",
          id: `widget-${i}-a`,
          type: "chart",
          title: `Chart ${i}A`,
          query: `/api/data-${i}`,
        },
        {
          pluginName: "",
          id: `widget-${i}-b`,
          type: "status-card",
          title: `Status ${i}B`,
        },
      ])
    );

    const ctx = makeCtx(plugins);
    const [route] = createRoutes(ctx);

    const start = performance.now();
    const resp = await route.handler(new Request("http://localhost/api/widgets"), {});
    const elapsed = performance.now() - start;

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as WidgetDescriptor[];
    expect(body).toHaveLength(20);

    // Assembly must be fast — well under 50ms
    expect(elapsed).toBeLessThan(50);
  });

  test("backward compat: plugins without getWidgets() are skipped", async () => {
    const plugins: Plugin[] = [
      // Older plugin with no getWidgets
      makePlugin("legacy-discord"),
      makePlugin("legacy-github"),
      // New plugin with getWidgets
      makePlugin("world-state-engine", worldStateWidgets()),
    ];

    const ctx = makeCtx(plugins);
    const [route] = createRoutes(ctx);
    const resp = await route.handler(new Request("http://localhost/api/widgets"), {});

    expect(resp.status).toBe(200);
    const body = (await resp.json()) as WidgetDescriptor[];

    // Only widgets from the new plugin appear
    expect(body).toHaveLength(2);
    expect(body.every((w) => w.pluginName === "world-state-engine")).toBe(true);
  });

  test("backward compat: empty plugin list returns empty array", async () => {
    const ctx = makeCtx([]);
    const [route] = createRoutes(ctx);
    const resp = await route.handler(new Request("http://localhost/api/widgets"), {});

    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toEqual([]);
  });

  test("response includes cache-control header", async () => {
    const ctx = makeCtx([makePlugin("world-state-engine", worldStateWidgets())]);
    const [route] = createRoutes(ctx);
    const resp = await route.handler(new Request("http://localhost/api/widgets"), {});

    const cc = resp.headers.get("cache-control");
    expect(cc).toBeTruthy();
    expect(cc).toContain("max-age=5");
  });

  test("widget ids are unique across plugins", async () => {
    const plugins: Plugin[] = [
      makePlugin("world-state-engine", worldStateWidgets()),
      makePlugin("event-viewer", eventStreamWidgets()),
      makePlugin("fleet-metrics", metricsWidgets()),
    ];

    const ctx = makeCtx(plugins);
    const [route] = createRoutes(ctx);
    const resp = await route.handler(new Request("http://localhost/api/widgets"), {});
    const body = (await resp.json()) as WidgetDescriptor[];

    const ids = body.map((w) => w.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
