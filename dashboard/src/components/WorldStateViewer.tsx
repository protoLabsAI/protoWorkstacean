import { useState, useEffect, useMemo } from "preact/hooks";
import DomainCard from "./DomainCard.tsx";
import { getWorldState, peek, type WorldStateResponse } from "../lib/api";

const POLL_INTERVAL = 15_000;

export default function WorldStateViewer() {
  // Seed from cache if present — instant render on page revisit
  const [worldState, setWorldState] = useState<WorldStateResponse | null>(
    () => peek<WorldStateResponse>("/api/world-state") ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(
    worldState ? new Date() : null,
  );
  const [filter, setFilter] = useState<string>("");
  const [selectedDomain, setSelectedDomain] = useState<string>("all");

  async function fetchWorldState(force = false) {
    try {
      const data = await getWorldState(force);
      setWorldState(data);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch world state");
    }
  }

  useEffect(() => {
    fetchWorldState(true); // force on mount to refresh
    const id = setInterval(() => fetchWorldState(true), POLL_INTERVAL);
    return () => clearInterval(id);
  }, []);

  const domainNames = useMemo(() => {
    if (!worldState) return [];
    return Object.keys(worldState.domains).sort();
  }, [worldState]);

  const visibleDomains = useMemo(() => {
    if (!worldState) return [];
    return domainNames.filter((name) => {
      if (selectedDomain !== "all" && name !== selectedDomain) return false;
      if (filter.trim()) {
        return name.toLowerCase().includes(filter.toLowerCase());
      }
      return true;
    });
  }, [domainNames, selectedDomain, filter, worldState]);

  const failedCount = useMemo(() => {
    if (!worldState) return 0;
    return Object.values(worldState.domains).filter((d) => d.metadata.failed).length;
  }, [worldState]);

  return (
    <>
      <style>{`
        .wsv-toolbar {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 20px;
          flex-wrap: wrap;
        }
        .wsv-filter {
          flex: 1;
          min-width: 160px;
          background: var(--bg-default);
          border: 1px solid var(--border-default);
          border-radius: 6px;
          color: var(--text-primary);
          font-size: 13px;
          padding: 6px 10px;
          outline: none;
        }
        .wsv-filter:focus {
          border-color: var(--accent-fg);
        }
        .wsv-filter::placeholder {
          color: var(--text-secondary);
        }
        .wsv-select {
          background: var(--bg-default);
          border: 1px solid var(--border-default);
          border-radius: 6px;
          color: var(--text-primary);
          font-size: 13px;
          padding: 6px 10px;
          outline: none;
          cursor: pointer;
        }
        .wsv-select:focus {
          border-color: var(--accent-fg);
        }
        .wsv-meta {
          font-size: 12px;
          color: var(--text-secondary);
          margin-left: auto;
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .wsv-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
          gap: 16px;
        }
        .wsv-error {
          background: rgba(248, 81, 73, 0.1);
          border: 1px solid rgba(248, 81, 73, 0.3);
          border-radius: 6px;
          color: var(--text-danger);
          font-size: 13px;
          padding: 12px 16px;
          margin-bottom: 16px;
        }
        .wsv-empty {
          color: var(--text-secondary);
          font-style: italic;
          text-align: center;
          padding: 48px 24px;
        }
        .wsv-failed-badge {
          display: inline-flex;
          align-items: center;
          background: rgba(248, 81, 73, 0.15);
          color: var(--text-danger);
          border-radius: 12px;
          font-size: 11px;
          font-weight: 500;
          padding: 2px 8px;
        }
      `}</style>

      <div class="wsv-toolbar">
        <input
          class="wsv-filter"
          type="text"
          placeholder="Filter domains…"
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        />

        {domainNames.length > 0 && (
          <select
            class="wsv-select"
            value={selectedDomain}
            onChange={(e) => setSelectedDomain((e.target as HTMLSelectElement).value)}
          >
            <option value="all">All domains ({domainNames.length})</option>
            {domainNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}

        <div class="wsv-meta">
          {failedCount > 0 && (
            <span class="wsv-failed-badge">{failedCount} failed</span>
          )}
          {lastUpdated && (
            <span>Updated {lastUpdated.toLocaleTimeString()}</span>
          )}
        </div>
      </div>

      {error && <div class="wsv-error">Error: {error}</div>}

      {!worldState && !error && (
        <div class="wsv-empty">Loading world state…</div>
      )}

      {worldState && visibleDomains.length === 0 && (
        <div class="wsv-empty">No domains match the current filter.</div>
      )}

      {worldState && visibleDomains.length > 0 && (
        <div class="wsv-grid">
          {visibleDomains.map((name) => {
            const domain = worldState.domains[name];
            return (
              <DomainCard
                key={name}
                name={name}
                data={domain.data}
                metadata={domain.metadata}
              />
            );
          })}
        </div>
      )}
    </>
  );
}
