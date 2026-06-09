/**
 * NodeInspector — slide-in right panel for a single agent node, opened by
 * clicking an agent in SystemGraph (ADR-0008 WS-3c).
 *
 * Composes the whole canvas into one in-context view:
 *   - tier (builtin / a2a) + remote host        (WS-3a)
 *   - live status + current skill + tool-calls   (agent.runtime.activity.*)
 *   - the agent's last flow item                 (flow store, via WS-3b's
 *     targetAgent fix) with a jump to /trace
 *   - a drill-out to /executions?target=<agent>  (WS-875)
 *
 * Self-contained like MessageDrawer: fixed right overlay, own <style>, closes
 * on backdrop click or Esc. Plain <a> links match the MessageDrawer idiom.
 */

import { useEffect, useState } from "react";
import type { AgentActivityState } from "./AgentNode.tsx";
import { getFlows, type FlowRecord } from "../lib/api";

export interface InspectorNode {
  name: string;
  type: string;
  host?: string;
  activity?: AgentActivityState;
}

interface Props {
  node: InspectorNode;
  onClose: () => void;
}

const tierLabel = (type: string) => (type === "a2a" ? "a2a" : "builtin");

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 1000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** The flow id is `skill-<correlationId>` — strip the prefix for the trace link. */
const correlationIdOf = (flowId: string) => (flowId.startsWith("skill-") ? flowId.slice("skill-".length) : flowId);

export default function NodeInspector({ node, onClose }: Props) {
  const activity = node.activity;
  const isRemote = node.type === "a2a";
  const [lastFlow, setLastFlow] = useState<FlowRecord | null>(null);
  const [flowState, setFlowState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The agent's most-recent flow item (now that flow.item.* carries targetAgent).
  useEffect(() => {
    let cancelled = false;
    setFlowState("loading");
    setLastFlow(null);
    getFlows(true)
      .then((data) => {
        if (cancelled) return;
        const mine = (data.flows ?? []).filter((f) => f.targetAgent === node.name);
        // /api/flows is newest-first; take the first match.
        setLastFlow(mine[0] ?? null);
        setFlowState("ready");
      })
      .catch(() => {
        if (!cancelled) setFlowState("error");
      });
    return () => { cancelled = true; };
  }, [node.name]);

  const status = activity?.status ?? "idle";
  const traceHref = lastFlow ? `/trace?correlationId=${encodeURIComponent(correlationIdOf(lastFlow.id))}` : null;

  return (
    <>
      <style>{STYLE}</style>
      <div className="ni-backdrop" onClick={onClose} />
      <aside className="ni-panel" role="dialog" aria-label={`Inspector for ${node.name}`}>
        <header className="ni-header">
          <div>
            <h3 className="ni-title">{node.name}</h3>
            <p className="ni-sub">
              <span className={`ni-tier ni-tier--${isRemote ? "a2a" : "builtin"}`}>{tierLabel(node.type)}</span>
              {isRemote && node.host && <span className="ni-host">⤳ {node.host}</span>}
              <span className={`ni-status ni-status--${status}`}>{status}</span>
            </p>
          </div>
          <button className="ni-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="ni-body">
          {/* Live activity */}
          <section className="ni-section">
            <div className="ni-label">Live</div>
            {activity?.currentSkill ? (
              <div className="ni-row">
                skill <span className="ni-strong">{activity.currentSkill}</span>
                {activity.startedAt && status === "running" && <span className="ni-dim"> · {relativeTime(activity.startedAt)}</span>}
              </div>
            ) : (
              <div className="ni-dim">No live skill.</div>
            )}
            {activity && activity.toolCalls.length > 0 && (
              <ul className="ni-tools">
                {activity.toolCalls.slice(0, 5).map((c, i) => (
                  <li key={i}>
                    <span className="ni-tool-mark">↳</span> <span className="ni-strong">{c.tools.join(", ")}</span>
                    <span className="ni-dim"> {relativeTime(c.timestamp)}</span>
                  </li>
                ))}
              </ul>
            )}
            {status === "error" && activity?.errorMessage && <div className="ni-err">⚠ {activity.errorMessage}</div>}
          </section>

          {/* Last flow item */}
          <section className="ni-section">
            <div className="ni-label">Last dispatch</div>
            {flowState === "loading" && <div className="ni-dim">Loading…</div>}
            {flowState === "error" && <div className="ni-dim">Flow store unavailable.</div>}
            {flowState === "ready" && !lastFlow && <div className="ni-dim">No recorded dispatches for {node.name}.</div>}
            {flowState === "ready" && lastFlow && (
              <div className="ni-flow">
                <div className="ni-row">
                  <span className={`ni-pill ni-pill--${lastFlow.status ?? "unknown"}`}>{lastFlow.status ?? "—"}</span>
                  <span className="ni-strong">{lastFlow.skill ?? "—"}</span>
                </div>
                <div className="ni-dim">
                  {fmtDuration(lastFlow.durationMs)} · {lastFlow.createdAt ? relativeTime(lastFlow.createdAt) : "—"}
                </div>
                {traceHref && <a className="ni-link" href={traceHref}>Open trace →</a>}
              </div>
            )}
          </section>
        </div>

        <footer className="ni-footer">
          <a className="ni-link" href={`/executions?target=${encodeURIComponent(node.name)}`}>View all executions →</a>
        </footer>
      </aside>
    </>
  );
}

const STYLE = `
  .ni-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.35); z-index: 100; }
  .ni-panel {
    position: fixed; top: 0; right: 0; height: 100vh; width: 380px; max-width: 90vw;
    background: var(--bg-canvas); border-left: 1px solid var(--border-default); color: var(--text-primary);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    z-index: 101; display: flex; flex-direction: column; box-shadow: -8px 0 24px rgba(0,0,0,0.5);
  }
  .ni-header { display: flex; align-items: flex-start; justify-content: space-between; padding: 1rem 1.25rem 0.75rem; border-bottom: 1px solid var(--border-muted); }
  .ni-title { margin: 0; font-size: 1rem; color: var(--text-primary); word-break: break-all; }
  .ni-sub { margin: 0.4rem 0 0; display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .ni-tier { font-size: 0.7rem; padding: 1px 6px; border-radius: 3px; border: 1px solid var(--border-default); }
  .ni-tier--a2a { color: var(--accent-fg); border-style: dashed; }
  .ni-tier--builtin { color: var(--text-secondary); }
  .ni-host { font-size: 0.75rem; color: var(--text-secondary); }
  .ni-status { font-size: 0.72rem; margin-left: auto; }
  .ni-status--running { color: var(--text-success); }
  .ni-status--error { color: var(--text-danger); }
  .ni-status--completed { color: var(--accent-fg); }
  .ni-status--idle { color: var(--text-secondary); }
  .ni-body { flex: 1; overflow-y: auto; padding: 0.5rem 1.25rem; }
  .ni-section { padding: 0.85rem 0; border-bottom: 1px dashed var(--border-muted); }
  .ni-label { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); margin-bottom: 0.5rem; }
  .ni-row { display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; margin-bottom: 0.25rem; }
  .ni-strong { color: var(--text-primary); }
  .ni-dim { color: var(--text-secondary); font-size: 0.76rem; }
  .ni-tools { list-style: none; padding: 0; margin: 0.4rem 0 0; }
  .ni-tools li { font-size: 0.76rem; color: var(--text-secondary); line-height: 1.5; }
  .ni-tool-mark { color: var(--text-success); }
  .ni-err { margin-top: 0.4rem; color: var(--text-danger); font-size: 0.76rem; }
  .ni-flow { display: flex; flex-direction: column; gap: 0.3rem; }
  .ni-pill { font-size: 0.7rem; padding: 1px 6px; border-radius: 3px; background: var(--bg-default); }
  .ni-pill--complete { color: var(--text-success); }
  .ni-pill--active { color: var(--text-warning); }
  .ni-pill--blocked { color: var(--text-danger); }
  .ni-link { color: var(--accent-fg); text-decoration: none; font-size: 0.78rem; }
  .ni-link:hover { text-decoration: underline; }
  .ni-footer { padding: 0.85rem 1.25rem; border-top: 1px solid var(--border-muted); }
`;
