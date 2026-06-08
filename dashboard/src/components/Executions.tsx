import { useEffect, useState } from "react";
import { getFlows, type FlowRecord } from "../lib/api";

const POLL_INTERVAL = 10_000;

/** Map executor type → node tier (ADR-0008: builtin in-process vs distributed a2a). */
function tier(executorType: string | null): { label: string; cls: string } {
  switch (executorType) {
    case "deep-agent":
      return { label: "builtin", cls: "tier-builtin" };
    case "a2a":
      return { label: "a2a · remote", cls: "tier-a2a" };
    case "function":
      return { label: "function", cls: "tier-fn" };
    case "mcp":
      return { label: "mcp", cls: "tier-mcp" };
    default:
      return { label: executorType ?? "—", cls: "tier-fn" };
  }
}

function statusColor(status: string | null): string {
  switch (status) {
    case "complete":
      return "var(--success, #41c48d)";
    case "active":
      return "var(--warning, #d4bd4f)";
    case "blocked":
      return "var(--error, #f07458)";
    default:
      return "var(--text-muted, #8b8b94)";
  }
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function fmtAge(ts: number | null): string {
  if (ts == null) return "—";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export default function Executions() {
  const [flows, setFlows] = useState<FlowRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh(force = false) {
    try {
      const data = await getFlows(force);
      setFlows(data.flows ?? []);
      setError(null);
      setLoading(false);
    } catch (err) {
      // 503 = flow-store not wired (older backend); show a hint, not a crash.
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh(true);
    const id = setInterval(() => refresh(true), POLL_INTERVAL);
    return () => clearInterval(id);
  }, []);

  if (loading && flows.length === 0 && !error) {
    return <div style={{ color: "var(--text-secondary)", padding: 48, textAlign: "center" }}>Loading executions…</div>;
  }

  const counts = flows.reduce<Record<string, number>>((acc, f) => {
    const k = f.status ?? "unknown";
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
        <h1 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Executions</h1>
        <span style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono, monospace)" }}>
          {flows.length} flows · {counts.complete ?? 0} complete · {counts.active ?? 0} active · {counts.blocked ?? 0} blocked
        </span>
      </div>

      {error && (
        <div style={{ color: "var(--text-muted)", fontSize: 12, padding: 12, border: "1px solid var(--border)", borderRadius: 6, marginBottom: 12 }}>
          {error.includes("503") ? "Execution log unavailable — the flow-store backend isn't wired on this server yet." : `Could not load executions: ${error}`}
        </div>
      )}

      {!error && flows.length === 0 && (
        <div style={{ color: "var(--text-muted)", padding: 48, textAlign: "center" }}>No dispatches recorded yet.</div>
      )}

      {flows.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", fontSize: 11, textAlign: "left" }}>
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>Status</th>
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>Skill</th>
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>Tier</th>
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>Target</th>
              <th style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}>Duration</th>
              <th style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}>When</th>
            </tr>
          </thead>
          <tbody>
            {flows.map((f) => {
              const t = tier(f.executorType);
              return (
                <tr key={f.id} style={{ borderTop: "1px solid var(--border)" }} title={f.errorPreview ?? undefined}>
                  <td style={{ padding: "6px 8px" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 999, background: statusColor(f.status) }} />
                      <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 11 }}>{f.status ?? "—"}</span>
                    </span>
                  </td>
                  <td style={{ padding: "6px 8px", fontFamily: "var(--font-mono, monospace)" }}>{f.skill ?? "—"}</td>
                  <td style={{ padding: "6px 8px" }}>
                    <span className={t.cls} style={{ fontSize: 11, fontFamily: "var(--font-mono, monospace)", color: "var(--text-secondary)" }}>{t.label}</span>
                  </td>
                  <td style={{ padding: "6px 8px", fontFamily: "var(--font-mono, monospace)", color: "var(--text-secondary)" }}>{f.targetAgent ?? "—"}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "var(--font-mono, monospace)", fontVariantNumeric: "tabular-nums" }}>{fmtDuration(f.durationMs)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--text-muted)", fontFamily: "var(--font-mono, monospace)" }}>{fmtAge(f.createdAt ?? f.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
