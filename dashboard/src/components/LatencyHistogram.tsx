/**
 * LatencyHistogram — bottom-left floating panel on /system showing per-skill
 * latency percentiles (count / p50 / p95 / max) since this dashboard tab
 * opened.
 *
 * Subscribes to `agent.skill.latency` (published by SkillDispatcherPlugin
 * after every webhook-stamped skill completion). Payload carries
 * `{ skill, totalMs, queueMs, executeMs }` — we accumulate per-skill samples
 * in a fixed-size ring (last 200 per skill) and re-compute the percentiles
 * on every new sample. Cheap; the samples-per-skill count is bounded by
 * webhook fan-in which is in the dozens per day at fleet size.
 *
 * "Since tab opened" rather than "rolling 24h" — server-side has no
 * sliding-window store yet, and the BusHistoryRecorder ring (10k events,
 * 30-min TTL) is too short for a useful baseline. v2 would seed from a
 * dedicated latency-history store on the server; v1 starts at zero each
 * fresh tab.
 *
 * Same WS + reconnect shape as QuinnVerdictCounters.
 */

import { useEffect, useState } from "react";

interface LatencyPayload {
  skill?: string;
  totalMs?: number;
  queueMs?: number;
  executeMs?: number;
}

/** Max samples retained per skill — newest-last ring. */
const SAMPLE_CAP = 200;

interface SkillSamples {
  /** Total-latency samples in ms; ring of up to SAMPLE_CAP, newest-last. */
  samples: number[];
}

interface Stats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

function statsFor(samples: number[]): Stats {
  if (samples.length === 0) return { count: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return {
    count: samples.length,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1]!,
  };
}

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

export default function LatencyHistogram() {
  const [perSkill, setPerSkill] = useState<Map<string, SkillSamples>>(new Map());
  const [openedAt] = useState<number>(() => Date.now());
  const [wsStatus, setWsStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/bus/subscribe?topic=agent.skill.latency`;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      ws = new WebSocket(url);
      ws.onopen = () => setWsStatus("connected");
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as { payload?: LatencyPayload };
          const p = msg.payload;
          if (!p?.skill || typeof p?.totalMs !== "number") return;
          setPerSkill((cur) => {
            const next = new Map(cur);
            const existing = next.get(p.skill!) ?? { samples: [] };
            const samples = [...existing.samples, p.totalMs!];
            if (samples.length > SAMPLE_CAP) samples.splice(0, samples.length - SAMPLE_CAP);
            next.set(p.skill!, { samples });
            return next;
          });
        } catch {
          // Ignore malformed frames.
        }
      };
      ws.onclose = () => {
        setWsStatus("disconnected");
        if (stopped) return;
        retryTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
    };
    connect();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);

  const rows = [...perSkill.entries()]
    .map(([skill, s]) => ({ skill, ...statsFor(s.samples) }))
    .sort((a, b) => b.count - a.count);

  const sinceMin = Math.floor((Date.now() - openedAt) / 60_000);

  return (
    <aside className="lh-panel" aria-label="Per-skill latency since page load">
      <header className="lh-head">
        <h3>Skill latency</h3>
        <p className="lh-meta">
          since tab opened {sinceMin}m ago ·{" "}
          <span className={`lh-status lh-status--${wsStatus}`}>{wsStatus}</span>
        </p>
      </header>

      {rows.length === 0 ? (
        <div className="lh-empty">No webhook-triggered completions observed yet.</div>
      ) : (
        <table className="lh-table">
          <thead>
            <tr>
              <th>skill</th>
              <th className="lh-num" title="sample count">n</th>
              <th className="lh-num" title="median">p50</th>
              <th className="lh-num" title="95th percentile">p95</th>
              <th className="lh-num" title="max observed">max</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.skill}>
                <td className="lh-skill" title={r.skill}>{r.skill}</td>
                <td className="lh-num">{r.count}</td>
                <td className="lh-num">{fmt(r.p50)}</td>
                <td className="lh-num lh-p95">{fmt(r.p95)}</td>
                <td className="lh-num lh-max">{fmt(r.max)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <style>{STYLES}</style>
    </aside>
  );
}

const STYLES = `
  .lh-panel {
    position: absolute;
    bottom: 12px;
    left: 12px;
    z-index: 5;
    min-width: 260px;
    max-width: 360px;
    background: rgba(13, 17, 23, 0.92);
    border: 1px solid #30363d;
    border-radius: 6px;
    color: #c9d1d9;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 0.8rem;
    backdrop-filter: blur(4px);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
  .lh-head {
    padding: 0.5rem 0.75rem 0.4rem;
    border-bottom: 1px solid #21262d;
  }
  .lh-head h3 {
    margin: 0;
    font-size: 0.85rem;
    color: #e6edf3;
  }
  .lh-meta {
    margin: 0.2rem 0 0;
    color: #8b949e;
    font-size: 0.7rem;
  }
  .lh-status { font-weight: 500; }
  .lh-status--connected    { color: #3fb950; }
  .lh-status--connecting   { color: #d29922; }
  .lh-status--disconnected { color: #f85149; }
  .lh-empty {
    padding: 0.75rem;
    color: #8b949e;
    font-size: 0.75rem;
  }
  .lh-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.75rem;
  }
  .lh-table thead th {
    text-align: left;
    color: #6e7681;
    font-weight: 500;
    padding: 0.4rem 0.5rem;
    border-bottom: 1px solid #21262d;
  }
  .lh-table th.lh-num { text-align: right; }
  .lh-table td {
    padding: 0.3rem 0.5rem;
    border-bottom: 1px dashed #21262d;
  }
  .lh-table tbody tr:last-child td { border-bottom: none; }
  .lh-num { text-align: right; width: 4rem; }
  .lh-skill {
    color: #c9d1d9;
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lh-p95 { color: #d29922; }
  .lh-max { color: #f85149; }
`;
