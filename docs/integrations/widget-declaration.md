---
title: Declaring Dashboard Widgets
description: How plugin authors add widgets to the discovery-driven dashboard
---

# Declaring Dashboard Widgets

The protoWorkstacean dashboard is **discovery-driven**: plugins declare the widgets they contribute, and the dashboard renders them automatically. No hardcoded pages. No dashboard config files.

## How it works

1. A plugin implements `getWidgets(): WidgetDescriptor[]`
2. The runtime calls `GET /api/widgets` to aggregate all declared widgets
3. The dashboard fetches `/api/widgets` and renders each widget using its `type`

---

## Quick start

### 1. Implement `getWidgets()` on your plugin

```typescript
import type { Plugin, EventBus, WidgetDescriptor } from "../types.ts";

export class MyPlugin implements Plugin {
  name = "my-plugin";
  description = "Does something useful";
  capabilities: string[] = [];

  install(bus: EventBus): void { /* subscribe to topics */ }
  uninstall(): void { /* cleanup */ }

  getWidgets(): WidgetDescriptor[] {
    return [
      {
        pluginName: this.name,
        id: "my-status-card",
        type: "status-card",
        title: "My Service Status",
        query: "/api/my-plugin/status",
        props: {
          refreshIntervalMs: 15_000,
        },
      },
    ];
  }
}
```

That's it. The dashboard picks up your widget automatically on next render.

### 2. Register your plugin

Ensure your plugin instance is included in the `plugins` array passed to `ApiContext`. The runtime discovers plugins at startup — no additional wiring is needed.

---

## WidgetDescriptor fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pluginName` | `string` | Yes | Set to `this.name`. Overwritten by `/api/widgets` stamping — used for attribution in the UI. |
| `id` | `string` | Yes | Unique across all plugins. Use `kebab-case`. Example: `"world-state-domain-grid"`. |
| `type` | `WidgetType` | Yes | Controls which renderer is used. See [Widget types](#widget-types). |
| `title` | `string` | Yes | Human-readable label shown in the dashboard header. |
| `query` | `string` | No | API endpoint the widget polls for data. Must be a path relative to the server root (e.g. `"/api/world-state"`). |
| `props` | `Record<string, unknown>` | No | Renderer-specific options (chart type, refresh interval, limits, etc.). |

### Widget types

| Type | Renderer | Use when |
|------|----------|----------|
| `chart` | `ChartRenderer` | Time-series or categorical data (line, bar, area) |
| `table` | `TableRenderer` | Tabular data with rows and columns |
| `status-card` | `StatusCardRenderer` | Single-value health/status indicators |
| `log-stream` | `EventStream` | Real-time event/log feeds (WebSocket-backed) |
| `metric` | `MetricRenderer` | Single numeric KPI with optional trend |

---

## Rules for plugin authors

### IDs must be globally unique

Widget `id` is used as a React key and for URL routing. Namespace it with your plugin name:

```
my-plugin-status-card    ✅
status-card              ❌  (collides with other plugins)
```

### `getWidgets()` must be pure and fast

`getWidgets()` is called on every cache miss (every 5 seconds). It must:
- Return a static array — do not fetch or await inside `getWidgets()`
- Not throw — errors from `getWidgets()` propagate to `/api/widgets` callers
- Return the same set of widgets for the lifetime of the plugin instance

### `query` endpoints must exist

If you declare `query: "/api/my-plugin/data"`, that route must exist in your plugin or the shared API layer. The dashboard does not validate `query` at discovery time — a broken query URL shows an error in the widget, not at startup.

### `pluginName` is overwritten

`/api/widgets` stamps `pluginName` from `plugin.name` regardless of what you set in the descriptor. You should still set it to `this.name` for clarity in tests and local usage.

---

## Example: multiple widget types from one plugin

```typescript
getWidgets(): WidgetDescriptor[] {
  return [
    {
      pluginName: this.name,
      id: "github-pr-table",
      type: "table",
      title: "Open Pull Requests",
      query: "/api/github/prs",
      props: { columns: ["title", "author", "status", "age"] },
    },
    {
      pluginName: this.name,
      id: "github-ci-status",
      type: "status-card",
      title: "CI Health",
      query: "/api/github/ci-status",
    },
    {
      pluginName: this.name,
      id: "github-merge-rate",
      type: "chart",
      title: "Merge Rate (7d)",
      query: "/api/github/merge-rate",
      props: { chartType: "bar", unit: "PRs/day" },
    },
  ];
}
```

---

## Template plugin

A copy-pasteable starting point lives at:

```
lib/plugins/example-template-plugin.ts
```

Copy it, rename the class and `name`, and replace the example widgets with your own.

---

## Testing your widgets

Write a unit test that calls `getWidgets()` directly and asserts the returned descriptors:

```typescript
import { describe, test, expect } from "bun:test";
import { MyPlugin } from "../../lib/plugins/my-plugin.ts";

describe("MyPlugin.getWidgets()", () => {
  test("returns expected widget ids", () => {
    const plugin = new MyPlugin();
    const widgets = plugin.getWidgets();

    expect(widgets.length).toBeGreaterThan(0);
    for (const w of widgets) {
      expect(w.id).toContain("my-plugin");
      expect(w.pluginName).toBe("my-plugin");
      expect(w.type).toBeTruthy();
      expect(w.title).toBeTruthy();
    }
  });
});
```

For end-to-end verification, see `test/integration/widget-discovery.test.ts`.
