/**
 * MessageDrawer — slide-in side panel showing the recent message history for
 * a single bus topic, opened by clicking an edge in SystemGraph (D3).
 *
 * The SystemGraph keeps a per-topic ring buffer of the last N WS-observed
 * messages — this component renders that slice as a scrollable list of
 * timestamp / correlationId / payload-preview rows. Clicking a row's
 * correlationId opens the trace waterfall at /trace?correlationId=... (D1),
 * stitching the two debugging surfaces together.
 *
 * Drawer behavior: fixed right-side overlay, closes on backdrop click or
 * Esc. No portal — Astro client:load renders the component in-place under
 * the SystemGraph container, and `position: fixed` lifts it visually.
 */

import { useEffect } from "react";

export interface DrawerMessage {
  /** Stable id (random or msg.id from the WS frame) — used as React key. */
  id: string;
  topic: string;
  correlationId?: string;
  timestamp: number;
  payload?: unknown;
}

interface Props {
  topic: string;
  messages: DrawerMessage[];
  onClose: () => void;
}

export default function MessageDrawer({ topic, messages, onClose }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="md-backdrop" onClick={onClose} />
      <aside className="md-drawer" role="dialog" aria-label={`Messages on topic ${topic}`}>
        <header className="md-header">
          <div>
            <h3 className="md-title">{topic}</h3>
            <p className="md-meta">
              {messages.length} message{messages.length === 1 ? "" : "s"} in WS buffer
              {messages.length > 0 && ` · newest ${relativeTime(messages[messages.length - 1].timestamp)}`}
            </p>
          </div>
          <button className="md-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        {messages.length === 0 ? (
          <div className="md-empty">
            No traffic observed on this topic since this dashboard opened.
            History resets on each page load — the WS subscription only
            captures messages that fire while you're watching.
          </div>
        ) : (
          <ol className="md-list">
            {[...messages].reverse().map((m) => (
              <li className="md-row" key={m.id}>
                <div className="md-row-head">
                  <span className="md-ts">{new Date(m.timestamp).toLocaleTimeString()}</span>
                  {m.correlationId ? (
                    <a className="md-trace-link" href={`/trace?correlationId=${encodeURIComponent(m.correlationId)}`}>
                      trace →
                    </a>
                  ) : (
                    <span className="md-no-trace">no correlationId</span>
                  )}
                </div>
                {m.correlationId && (
                  <code className="md-corr">{m.correlationId}</code>
                )}
                <pre className="md-payload">{previewPayload(m.payload)}</pre>
              </li>
            ))}
          </ol>
        )}
      </aside>

      <style>{DRAWER_STYLES}</style>
    </>
  );
}

function relativeTime(ts: number): string {
  const dt = Date.now() - ts;
  if (dt < 1000) return "just now";
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  return `${Math.floor(dt / 60_000)}m ago`;
}

function previewPayload(payload: unknown): string {
  if (payload == null) return "(empty)";
  try {
    const s = JSON.stringify(payload, null, 2);
    if (s.length > 1200) return s.slice(0, 1200) + "\n… (truncated)";
    return s;
  } catch {
    return String(payload);
  }
}

const DRAWER_STYLES = `
  .md-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.35);
    z-index: 100;
  }
  .md-drawer {
    position: fixed;
    top: 0;
    right: 0;
    height: 100vh;
    width: 480px;
    max-width: 90vw;
    background: #0d1117;
    border-left: 1px solid #30363d;
    color: #c9d1d9;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    z-index: 101;
    display: flex;
    flex-direction: column;
    box-shadow: -8px 0 24px rgba(0, 0, 0, 0.5);
  }
  .md-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid #21262d;
  }
  .md-title {
    margin: 0;
    font-size: 0.95rem;
    color: #58a6ff;
    word-break: break-all;
  }
  .md-meta {
    margin: 0.25rem 0 0;
    color: #8b949e;
    font-size: 0.8rem;
  }
  .md-close {
    background: transparent;
    border: none;
    color: #8b949e;
    font-size: 1.5rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.25rem;
  }
  .md-close:hover { color: #f85149; }
  .md-empty {
    padding: 2rem 1.25rem;
    color: #8b949e;
    font-size: 0.85rem;
    line-height: 1.5;
  }
  .md-list {
    list-style: none;
    padding: 0.75rem 1.25rem;
    margin: 0;
    overflow-y: auto;
    flex: 1;
  }
  .md-row {
    margin-bottom: 1rem;
    padding-bottom: 1rem;
    border-bottom: 1px dashed #21262d;
  }
  .md-row:last-child { border-bottom: none; }
  .md-row-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.35rem;
  }
  .md-ts { color: #8b949e; font-size: 0.8rem; }
  .md-trace-link {
    color: #58a6ff;
    text-decoration: none;
    font-size: 0.8rem;
  }
  .md-trace-link:hover { text-decoration: underline; }
  .md-no-trace { color: #6e7681; font-size: 0.75rem; font-style: italic; }
  .md-corr {
    display: block;
    color: #c9d1d9;
    font-size: 0.75rem;
    margin-bottom: 0.35rem;
    opacity: 0.7;
    word-break: break-all;
  }
  .md-payload {
    background: #161b22;
    padding: 0.6rem;
    margin: 0;
    border-radius: 4px;
    font-size: 0.75rem;
    overflow-x: auto;
    max-height: 240px;
    overflow-y: auto;
    color: #c9d1d9;
  }
`;
