// StatusCardRenderer — renders a key-value status display from a StatusCardWidgetDescriptor.
//
// Each entry in config.entries maps a data key to a human-readable label.
// An optional statusKey drives the card's border/accent color via statusMap.
// Missing or invalid data is handled gracefully.

import { useState, useEffect } from "preact/hooks";
import type { StatusCardWidgetDescriptor, StatusLevel } from "../../lib/widget-renderer";
import { fetchWidgetData, formatValue } from "../../lib/widget-renderer";

const STATUS_COLORS: Record<StatusLevel, string> = {
  healthy: "#3fb950",
  degraded: "#d29922",
  down: "#f85149",
  unknown: "#8b949e",
};

const STATUS_BORDER: Record<StatusLevel, string> = {
  healthy: "rgba(63, 185, 80, 0.3)",
  degraded: "rgba(210, 153, 34, 0.3)",
  down: "rgba(248, 81, 73, 0.3)",
  unknown: "var(--border-default, #30363d)",
};

function deriveStatus(
  data: Record<string, unknown>,
  statusKey?: string,
  statusMap?: Record<string, StatusLevel>,
): StatusLevel {
  if (!statusKey) return "unknown";
  const raw = String(data[statusKey] ?? "");
  return statusMap?.[raw] ?? "unknown";
}

interface StatusCardRendererProps {
  descriptor: StatusCardWidgetDescriptor;
}

export default function StatusCardRenderer({ descriptor }: StatusCardRendererProps) {
  const [data, setData] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { config } = descriptor;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await fetchWidgetData<unknown>(descriptor);
        if (cancelled) return;
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          setError("Expected object data for status card");
          return;
        }
        setData(result as Record<string, unknown>);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      }
    }

    load();
    const ttl = descriptor.query.ttl ?? 30_000;
    const id = setInterval(load, ttl);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [descriptor.id, descriptor.query.url]);

  const status = data ? deriveStatus(data, config.statusKey, config.statusMap) : "unknown";
  const statusColor = STATUS_COLORS[status];
  const borderColor = data ? STATUS_BORDER[status] : "var(--border-default, #30363d)";

  return (
    <>
      <style>{`
        .status-card {
          display: flex;
          flex-direction: column;
          gap: 12px;
          border: 1px solid var(--border-default, #30363d);
          border-radius: 8px;
          padding: 16px;
          background: var(--bg-card, #0d1117);
          transition: border-color 0.2s;
        }
        .status-card__header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .status-card__title {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary, #e6edf3);
          letter-spacing: 0.02em;
        }
        .status-card__dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .status-card__grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 10px 16px;
        }
        .status-card__entry {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .status-card__label {
          font-size: 11px;
          color: var(--text-muted, #8b949e);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .status-card__value {
          font-size: 15px;
          font-weight: 600;
          color: var(--text-primary, #e6edf3);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .status-card__empty,
        .status-card__error {
          font-size: 12px;
          color: var(--text-muted, #8b949e);
          text-align: center;
          padding: 12px 0;
        }
        .status-card__error {
          color: var(--color-danger, #f85149);
        }
        @keyframes status-pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
      `}</style>
      <div class="status-card" style={{ borderColor }}>
        <div class="status-card__header">
          <div class="status-card__title">{descriptor.title}</div>
          {data && (
            <span
              class="status-card__dot"
              style={{
                background: statusColor,
                animation: status === "unknown" ? "status-pulse 1.4s ease-in-out infinite" : "none",
              }}
              aria-label={`Status: ${status}`}
            />
          )}
        </div>

        {error ? (
          <div class="status-card__error">{error}</div>
        ) : data === null ? (
          <div class="status-card__empty">Loading…</div>
        ) : (
          <div class="status-card__grid">
            {config.entries.map((entry) => (
              <div key={entry.key} class="status-card__entry">
                <div class="status-card__label">{entry.label}</div>
                <div class="status-card__value" title={String(data[entry.key] ?? "—")}>
                  {formatValue(data[entry.key], entry.format)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
