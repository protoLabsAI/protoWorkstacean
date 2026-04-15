// WidgetDescriptor contract and data fetching utilities for generic widget renderers.
//
// Note: ChartRenderer uses SVG-based charts (inline, no external deps).
// If Recharts is desired in future, enable preact/compat in astro.config.mjs
// and add `recharts` to dashboard/package.json.

// ── Types ─────────────────────────────────────────────────────────────────────

export type ChartType = "line" | "bar" | "area";

export interface ChartConfig {
  type: ChartType;
  xKey: string;
  yKeys: string[];
  colors?: string[];
  height?: number;
}

export interface TableConfig {
  columns: Array<{
    key: string;
    label: string;
    align?: "left" | "right" | "center";
  }>;
}

export type StatusLevel = "healthy" | "degraded" | "down" | "unknown";

export interface StatusCardConfig {
  entries: Array<{
    key: string;
    label: string;
    format?: "percent" | "bytes" | "ms" | "number" | "text";
  }>;
  /** Key in the data whose value is used to derive the card's overall status color. */
  statusKey?: string;
  /** Maps statusKey values to a StatusLevel. Falls back to "unknown". */
  statusMap?: Record<string, StatusLevel>;
}

interface BaseWidgetDescriptor {
  id: string;
  title: string;
  query: {
    url: string;
    ttl?: number;
    /** Dot-path to extract from the response. E.g. "items" or "data.rows". */
    dataPath?: string;
  };
}

export interface ChartWidgetDescriptor extends BaseWidgetDescriptor {
  type: "chart";
  config: ChartConfig;
}

export interface TableWidgetDescriptor extends BaseWidgetDescriptor {
  type: "table";
  config: TableConfig;
}

export interface StatusCardWidgetDescriptor extends BaseWidgetDescriptor {
  type: "status-card";
  config: StatusCardConfig;
}

export type WidgetDescriptor =
  | ChartWidgetDescriptor
  | TableWidgetDescriptor
  | StatusCardWidgetDescriptor;

// ── Cache ─────────────────────────────────────────────────────────────────────

const cache = new Map<string, { data: unknown; expiry: number }>();

function unwrapEnvelope(raw: unknown): unknown {
  if (
    raw !== null &&
    typeof raw === "object" &&
    "success" in raw &&
    "data" in (raw as Record<string, unknown>)
  ) {
    return (raw as { success: boolean; data: unknown }).data;
  }
  return raw;
}

function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce((acc: unknown, key) => {
    if (acc !== null && typeof acc === "object") {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

// ── Data fetching ─────────────────────────────────────────────────────────────

export async function fetchWidgetData<T = unknown>(
  descriptor: WidgetDescriptor,
): Promise<T> {
  const { url, ttl = 30_000, dataPath } = descriptor.query;
  const cacheKey = `widget:${url}`;

  const cached = cache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    return cached.data as T;
  }

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(
      `Widget "${descriptor.id}" query failed: ${res.status} ${res.statusText}`,
    );
  }

  const raw: unknown = await res.json();
  let data = unwrapEnvelope(raw);

  if (dataPath) {
    data = getByPath(data, dataPath);
  }

  cache.set(cacheKey, { data, expiry: Date.now() + ttl });
  return data as T;
}

// ── Format helpers ─────────────────────────────────────────────────────────────

export function formatValue(
  value: unknown,
  format?: StatusCardConfig["entries"][number]["format"],
): string {
  if (value === null || value === undefined) return "—";
  const n = typeof value === "number" ? value : parseFloat(String(value));

  switch (format) {
    case "percent":
      return isNaN(n) ? String(value) : `${(n * 100).toFixed(1)}%`;
    case "bytes": {
      if (isNaN(n)) return String(value);
      if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
      if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
      if (n >= 1_024) return `${(n / 1_024).toFixed(1)} KB`;
      return `${n} B`;
    }
    case "ms":
      return isNaN(n) ? String(value) : `${n.toFixed(0)}ms`;
    case "number":
      return isNaN(n) ? String(value) : n.toLocaleString();
    default:
      return String(value);
  }
}
