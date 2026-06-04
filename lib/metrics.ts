/**
 * Minimal in-process metrics registry rendered in Prometheus text-exposition
 * format — no external dependency (fits the single-node deploy). Backs the
 * `GET /metrics` endpoint so dispatch/error/latency can be scraped + alerted on
 * over time, instead of only the in-memory 24h fleet-health snapshot. (#800)
 *
 * Counters are monotonic; histograms use a fixed latency-oriented bucket set.
 * Labels are low-cardinality only (skill, success, name) — never user/PR ids.
 */

type Labels = Record<string, string>;

const LATENCY_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000];

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${JSON.stringify(String(labels[k]))}`).join(",");
}

interface Histogram {
  labels: Labels;
  bucketCounts: number[]; // cumulative counts are computed at render time
  rawCounts: number[]; // per-bucket (le) counts
  sum: number;
  count: number;
}

export class MetricsRegistry {
  private counters = new Map<string, { name: string; labels: Labels; value: number }>();
  private histograms = new Map<string, Histogram & { name: string }>();

  inc(name: string, labels: Labels = {}, by = 1): void {
    const k = `${name}|${labelKey(labels)}`;
    const cur = this.counters.get(k);
    if (cur) cur.value += by;
    else this.counters.set(k, { name, labels, value: by });
  }

  observe(name: string, valueMs: number, labels: Labels = {}): void {
    const k = `${name}|${labelKey(labels)}`;
    let h = this.histograms.get(k);
    if (!h) {
      h = { name, labels, bucketCounts: [], rawCounts: new Array(LATENCY_BUCKETS_MS.length + 1).fill(0), sum: 0, count: 0 };
      this.histograms.set(k, h);
    }
    let i = LATENCY_BUCKETS_MS.findIndex((b) => valueMs <= b);
    if (i === -1) i = LATENCY_BUCKETS_MS.length; // +Inf bucket
    h.rawCounts[i] += 1;
    h.sum += valueMs;
    h.count += 1;
  }

  /** Render the registry in Prometheus 0.0.4 text-exposition format. */
  render(): string {
    const lines: string[] = [];
    const counterNames = new Set([...this.counters.values()].map((c) => c.name));
    for (const name of counterNames) {
      lines.push(`# TYPE ${name} counter`);
      for (const c of this.counters.values()) {
        if (c.name !== name) continue;
        lines.push(`${name}${renderLabels(c.labels)} ${c.value}`);
      }
    }
    const histoNames = new Set([...this.histograms.values()].map((h) => h.name));
    for (const name of histoNames) {
      lines.push(`# TYPE ${name} histogram`);
      for (const h of this.histograms.values()) {
        if (h.name !== name) continue;
        let cumulative = 0;
        for (let i = 0; i < LATENCY_BUCKETS_MS.length; i++) {
          cumulative += h.rawCounts[i];
          lines.push(`${name}_bucket${renderLabels({ ...h.labels, le: String(LATENCY_BUCKETS_MS[i]) })} ${cumulative}`);
        }
        cumulative += h.rawCounts[LATENCY_BUCKETS_MS.length];
        lines.push(`${name}_bucket${renderLabels({ ...h.labels, le: "+Inf" })} ${cumulative}`);
        lines.push(`${name}_sum${renderLabels(h.labels)} ${h.sum}`);
        lines.push(`${name}_count${renderLabels(h.labels)} ${h.count}`);
      }
    }
    return lines.join("\n") + "\n";
  }

  /** Test/reset hook. */
  reset(): void {
    this.counters.clear();
    this.histograms.clear();
  }
}

function renderLabels(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return "{" + keys.map((k) => `${k}=${JSON.stringify(String(labels[k]))}`).join(",") + "}";
}

/** Process-wide registry. */
export const metrics = new MetricsRegistry();
