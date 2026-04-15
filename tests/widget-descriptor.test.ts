import { describe, it, expect } from "bun:test";
import type { Plugin, WidgetDescriptor, WidgetType } from "../lib/types";

// Minimal EventBus stub
const stubBus: import("../lib/types").EventBus = {
  publish: () => {},
  subscribe: () => "id",
  unsubscribe: () => {},
  topics: () => [],
  consumers: () => [],
};

describe("Plugin without getWidgets still works", () => {
  it("installs and uninstalls without getWidgets", () => {
    let installed = false;
    const plugin: Plugin = {
      name: "basic",
      description: "no widgets",
      capabilities: [],
      install(_bus) { installed = true; },
      uninstall() { installed = false; },
    };
    plugin.install(stubBus);
    expect(installed).toBe(true);
    plugin.uninstall();
    expect(installed).toBe(false);
    expect(plugin.getWidgets).toBeUndefined();
  });
});

describe("WidgetDescriptor contract shape", () => {
  it("accepts all widget types", () => {
    const types: WidgetType[] = ["chart", "table", "status-card", "log-stream", "metric"];
    for (const type of types) {
      const w: WidgetDescriptor = { id: `w-${type}`, type, title: type };
      expect(w.id).toBe(`w-${type}`);
      expect(w.type).toBe(type);
    }
  });

  it("allows optional query and props", () => {
    const w: WidgetDescriptor = {
      id: "w1",
      type: "chart",
      title: "My Chart",
      query: "SELECT count FROM metrics",
      props: { color: "blue" },
    };
    expect(w.query).toBe("SELECT count FROM metrics");
    expect(w.props).toEqual({ color: "blue" });
  });

  it("plugin with getWidgets returns descriptors", () => {
    const widget: WidgetDescriptor = { id: "status", type: "status-card", title: "Status" };
    const plugin: Plugin = {
      name: "widget-plugin",
      description: "has widgets",
      capabilities: [],
      install() {},
      uninstall() {},
      getWidgets() { return [widget]; },
    };
    expect(plugin.getWidgets!()).toHaveLength(1);
    expect(plugin.getWidgets!()[0]).toEqual(widget);
  });
});
