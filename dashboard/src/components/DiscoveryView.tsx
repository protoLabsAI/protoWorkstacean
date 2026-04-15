// DiscoveryView — fetches /api/widgets and renders all plugin widgets grouped by plugin name.
//
// Maps the server-side WidgetDescriptor (lib/types.ts) to the dashboard-internal
// renderer descriptor format (lib/widget-renderer.ts) at runtime.

import { useState, useEffect } from "preact/hooks";
import type {
  ChartWidgetDescriptor,
  TableWidgetDescriptor,
  StatusCardWidgetDescriptor,
  ChartConfig,
  TableConfig,
  StatusCardConfig,
} from "../lib/widget-renderer";
import ChartRenderer from "./renderers/ChartRenderer";
import TableRenderer from "./renderers/TableRenderer";
import StatusCardRenderer from "./renderers/StatusCardRenderer";

// Shape returned by GET /api/widgets (matches lib/types.ts WidgetDescriptor)
interface ApiWidget {
  pluginName: string;
  id: string;
  type: string;
  title: string;
  query?: string;
  props?: Record<string, unknown>;
}

type RendererDescriptor =
  | ChartWidgetDescriptor
  | TableWidgetDescriptor
  | StatusCardWidgetDescriptor;

function toRendererDescriptor(w: ApiWidget): RendererDescriptor | null {
  const query = { url: w.query ?? "" };
  switch (w.type) {
    case "chart":
      return {
        id: w.id,
        title: w.title,
        type: "chart",
        config: (w.props ?? {}) as ChartConfig,
        query,
      };
    case "table":
      return {
        id: w.id,
        title: w.title,
        type: "table",
        config: (w.props ?? {}) as TableConfig,
        query,
      };
    case "status-card":
      return {
        id: w.id,
        title: w.title,
        type: "status-card",
        config: (w.props ?? {}) as StatusCardConfig,
        query,
      };
    default:
      // log-stream, metric, unknown — no renderer yet
      return null;
  }
}

function groupByPlugin(widgets: ApiWidget[]): Map<string, ApiWidget[]> {
  const groups = new Map<string, ApiWidget[]>();
  for (const w of widgets) {
    const existing = groups.get(w.pluginName) ?? [];
    existing.push(w);
    groups.set(w.pluginName, existing);
  }
  return groups;
}

interface WidgetCardProps {
  widget: ApiWidget;
}

function WidgetCard({ widget }: WidgetCardProps) {
  const descriptor = toRendererDescriptor(widget);

  if (!descriptor) {
    return (
      <div class="discovery-widget discovery-widget--unsupported">
        <div class="discovery-widget__title">{widget.title}</div>
        <div class="discovery-widget__unsupported">
          No renderer for type: {widget.type}
        </div>
      </div>
    );
  }

  return (
    <div class="discovery-widget">
      {descriptor.type === "chart" && (
        <ChartRenderer descriptor={descriptor} />
      )}
      {descriptor.type === "table" && (
        <TableRenderer descriptor={descriptor} />
      )}
      {descriptor.type === "status-card" && (
        <StatusCardRenderer descriptor={descriptor} />
      )}
    </div>
  );
}

interface PluginSectionProps {
  pluginName: string;
  widgets: ApiWidget[];
}

function PluginSection({ pluginName, widgets }: PluginSectionProps) {
  return (
    <section class="discovery-plugin-section">
      <h2 class="discovery-plugin-section__name">{pluginName}</h2>
      <div class="discovery-widget-grid">
        {widgets.map((w) => (
          <WidgetCard key={w.id} widget={w} />
        ))}
      </div>
    </section>
  );
}

interface DiscoveryViewProps {
  /** When set, only shows widgets for this plugin name. Null/undefined = show all. */
  pluginFilter?: string | null;
}

export default function DiscoveryView({ pluginFilter }: DiscoveryViewProps) {
  const [widgets, setWidgets] = useState<ApiWidget[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/widgets", {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          throw new Error(`/api/widgets returned ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        if (cancelled) return;
        // Handle both raw array and { success, data } envelope
        const list: ApiWidget[] = Array.isArray(data)
          ? data
          : Array.isArray(data?.data)
            ? data.data
            : [];
        setWidgets(list);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load widgets");
      }
    }

    load();
    // Refresh every 30s so new plugin registrations surface without a full reload
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return (
      <>
        <style>{styles}</style>
        <div class="discovery-error">
          <div class="discovery-error__title">Failed to load widgets</div>
          <div class="discovery-error__message">{error}</div>
        </div>
      </>
    );
  }

  if (widgets === null) {
    return (
      <>
        <style>{styles}</style>
        <div class="discovery-loading">Loading widgets…</div>
      </>
    );
  }

  const filtered = pluginFilter
    ? widgets.filter((w) => w.pluginName === pluginFilter)
    : widgets;

  if (filtered.length === 0) {
    return (
      <>
        <style>{styles}</style>
        <div class="discovery-empty">
          {pluginFilter
            ? `No widgets registered by "${pluginFilter}".`
            : "No widgets registered. Plugins can contribute widgets via getWidgets()."}
        </div>
      </>
    );
  }

  const groups = groupByPlugin(filtered);

  return (
    <>
      <style>{styles}</style>
      <div class="discovery-view">
        {[...groups.entries()].map(([pluginName, pluginWidgets]) => (
          <PluginSection
            key={pluginName}
            pluginName={pluginName}
            widgets={pluginWidgets}
          />
        ))}
      </div>
    </>
  );
}

const styles = `
  .discovery-view {
    display: flex;
    flex-direction: column;
    gap: 32px;
  }

  .discovery-plugin-section {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .discovery-plugin-section__name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary, #8b949e);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-bottom: 1px solid var(--border-default, #30363d);
    padding-bottom: 8px;
  }

  .discovery-widget-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 16px;
  }

  .discovery-widget {
    background: var(--bg-card, #161b22);
    border: 1px solid var(--border-default, #30363d);
    border-radius: 8px;
    padding: 16px;
    min-width: 0;
  }

  .discovery-widget--unsupported {
    opacity: 0.6;
  }

  .discovery-widget__title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary, #e6edf3);
    margin-bottom: 8px;
  }

  .discovery-widget__unsupported {
    font-size: 12px;
    color: var(--text-muted, #8b949e);
    font-style: italic;
  }

  .discovery-loading,
  .discovery-empty,
  .discovery-error {
    padding: 48px 24px;
    text-align: center;
    color: var(--text-muted, #8b949e);
    font-size: 14px;
  }

  .discovery-error__title {
    font-weight: 600;
    color: var(--text-danger, #f85149);
    margin-bottom: 8px;
  }

  .discovery-error__message {
    font-size: 12px;
    font-family: monospace;
  }
`;
