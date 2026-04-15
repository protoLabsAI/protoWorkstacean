/**
 * ExampleTemplatePlugin — starter template for plugin authors.
 *
 * Copy this file, rename the class, and fill in your own logic.
 * The only required step to participate in widget discovery is
 * implementing getWidgets() and returning one or more WidgetDescriptors.
 *
 * See docs/integrations/widget-declaration.md for full guidance.
 */

import type { Plugin, EventBus, WidgetDescriptor } from "../types.ts";

export class ExampleTemplatePlugin implements Plugin {
  name = "example-template";
  description = "A minimal example plugin that declares widgets for the dashboard";
  capabilities: string[] = ["dashboard"];

  private bus: EventBus | null = null;

  install(bus: EventBus): void {
    this.bus = bus;
    // Subscribe to relevant topics here, e.g.:
    // bus.subscribe("some.topic", this.name, (msg) => this.handleMessage(msg));
  }

  uninstall(): void {
    this.bus = null;
  }

  /**
   * Declare the widgets this plugin contributes to the dashboard.
   *
   * Called by GET /api/widgets. Return an array of WidgetDescriptors.
   * The runtime stamps pluginName from this.name — you don't need to set it.
   */
  getWidgets(): WidgetDescriptor[] {
    return [
      {
        pluginName: this.name, // stamped automatically by /api/widgets, but set here for clarity
        id: "example-status-card",
        type: "status-card",
        title: "Example Status",
        query: "/api/example/status",
        props: {
          refreshIntervalMs: 10_000,
        },
      },
      {
        pluginName: this.name,
        id: "example-metrics-chart",
        type: "chart",
        title: "Example Metrics",
        query: "/api/example/metrics",
        props: {
          chartType: "line",
          unit: "count",
        },
      },
    ];
  }
}
