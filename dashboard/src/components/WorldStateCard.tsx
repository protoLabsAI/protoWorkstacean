/**
 * WorldStateCard — generic renderer for world-state domain widgets.
 *
 * Renders a single domain entry from /api/world-state as a status card.
 * Used by the discovery-driven dashboard when a plugin declares a
 * world-state-domain-card WidgetDescriptor.
 */
import { useState } from "preact/hooks";
import JsonTree from "./JsonTree.tsx";

export interface WorldStateCardProps {
  name: string;
  data: unknown;
  metadata: {
    collectedAt: number;
    domain: string;
    tickNumber: number;
    failed?: boolean;
    errorMessage?: string;
  };
}

function relativeTime(ms: number): string {
  const diffMs = Date.now() - ms;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

export default function WorldStateCard({ name, data, metadata }: WorldStateCardProps) {
  const [expanded, setExpanded] = useState(false);
  const failed = metadata.failed === true;

  return (
    <div
      class="ws-card"
      style={{
        borderColor: failed ? "rgba(248, 81, 73, 0.5)" : "var(--border-default)",
        background: failed ? "rgba(248, 81, 73, 0.06)" : "var(--bg-default)",
      }}
    >
      <div class="ws-card__header">
        <div class="ws-card__title-row">
          <span
            class="ws-card__status-dot"
            style={{ background: failed ? "var(--text-danger)" : "var(--text-success)" }}
          />
          <span class="ws-card__name">{name}</span>
          {failed && (
            <span class="badge badge-red" style={{ marginLeft: "8px" }}>
              failed
            </span>
          )}
        </div>
        <div class="ws-card__meta">
          <span title={new Date(metadata.collectedAt).toISOString()}>
            {relativeTime(metadata.collectedAt)}
          </span>
          <span class="ws-card__sep">·</span>
          <span>tick #{metadata.tickNumber}</span>
        </div>
      </div>

      {failed && metadata.errorMessage && (
        <div class="ws-card__error">{metadata.errorMessage}</div>
      )}

      <button class="ws-card__toggle" onClick={() => setExpanded(!expanded)}>
        {expanded ? "Hide data ▲" : "Show data ▼"}
      </button>

      {expanded && (
        <div class="ws-card__data">
          <JsonTree value={data} />
        </div>
      )}

      <style>{`
        .ws-card {
          display: flex;
          flex-direction: column;
          gap: 10px;
          border: 1px solid var(--border-default);
          border-radius: 8px;
          padding: 14px 16px;
          transition: border-color 0.2s;
        }
        .ws-card__header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .ws-card__title-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .ws-card__status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .ws-card__name {
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary);
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        }
        .ws-card__meta {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: var(--text-secondary);
          flex-shrink: 0;
        }
        .ws-card__sep {
          color: var(--border-default);
        }
        .ws-card__error {
          font-size: 12px;
          color: var(--text-danger);
          background: rgba(248, 81, 73, 0.1);
          border: 1px solid rgba(248, 81, 73, 0.3);
          border-radius: 4px;
          padding: 6px 10px;
        }
        .ws-card__toggle {
          align-self: flex-start;
          background: none;
          border: 1px solid var(--border-muted);
          border-radius: 4px;
          color: var(--text-secondary);
          cursor: pointer;
          font-size: 12px;
          padding: 4px 10px;
          transition: border-color 0.1s, color 0.1s;
        }
        .ws-card__toggle:hover {
          border-color: var(--border-default);
          color: var(--text-primary);
        }
        .ws-card__data {
          background: var(--bg-inset);
          border: 1px solid var(--border-default);
          border-radius: 4px;
          padding: 12px;
          max-height: 400px;
          overflow-y: auto;
        }
      `}</style>
    </div>
  );
}
