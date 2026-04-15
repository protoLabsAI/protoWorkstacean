import { useState, useEffect } from "preact/hooks";
import { getEvents, peek } from "../lib/api";
import type { WsMessage } from "../lib/websocket";

const POLL_INTERVAL_MS = 60_000;
const EVENT_LIMIT = 500;
// Default model rates (USD per token)
const DEFAULT_INPUT_RATE = 0.000003;
const DEFAULT_OUTPUT_RATE = 0.000015;

interface OutcomePayload {
  systemActor?: string;
  skill?: string;
  success?: boolean;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  durationMs?: number;
  correlationId?: string;
}

interface AgentSkillRow {
  agent: string;
  skill: string;
  total: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  totalCostUsd: number;
  costPerSuccessfulOutcome: number;
}

function computeCost(usage?: OutcomePayload["usage"]): number {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0) * DEFAULT_INPUT_RATE +
    (usage.output_tokens ?? 0) * DEFAULT_OUTPUT_RATE;
}

function formatCost(usd: number): string {
  if (usd === 0) return "—";
  if (usd < 0.001) return `$${(usd * 1000).toFixed(3)}m`;
  return `$${usd.toFixed(4)}`;
}

function successRateColor(rate: number, total: number): string {
  if (total < 3) return "var(--text-muted)";
  if (rate >= 0.7) return "var(--text-success)";
  if (rate >= 0.5) return "var(--text-warning)";
  return "var(--text-danger)";
}

function aggregateRows(events: unknown[]): AgentSkillRow[] {
  const map = new Map<string, {
    total: number;
    successCount: number;
    failureCount: number;
    totalCostUsd: number;
  }>();

  for (const ev of events) {
    const msg = ev as WsMessage;
    if (!msg.topic?.startsWith("autonomous.outcome.")) continue;

    const p = msg.payload as OutcomePayload | undefined;
    if (!p?.systemActor || !p?.skill) continue;

    const key = `${p.systemActor}\0${p.skill}`;
    const existing = map.get(key) ?? { total: 0, successCount: 0, failureCount: 0, totalCostUsd: 0 };

    existing.total += 1;
    if (p.success) existing.successCount += 1;
    else existing.failureCount += 1;
    existing.totalCostUsd += computeCost(p.usage);

    map.set(key, existing);
  }

  const rows: AgentSkillRow[] = [];
  for (const [key, stats] of Array.from(map.entries())) {
    const [agent, skill] = key.split("\0");
    rows.push({
      agent,
      skill,
      total: stats.total,
      successCount: stats.successCount,
      failureCount: stats.failureCount,
      successRate: stats.total > 0 ? stats.successCount / stats.total : 0,
      totalCostUsd: stats.totalCostUsd,
      costPerSuccessfulOutcome:
        stats.successCount > 0 ? stats.totalCostUsd / stats.successCount : 0,
    });
  }

  // Sort: agents alphabetically, then skills alphabetically
  rows.sort((a, b) =>
    a.agent !== b.agent ? a.agent.localeCompare(b.agent) : a.skill.localeCompare(b.skill)
  );

  return rows;
}

export default function FleetCostView() {
  const cached = peek<unknown[]>("/api/events");
  const [rows, setRows] = useState<AgentSkillRow[]>(
    cached ? aggregateRows(cached) : [],
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!cached);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(cached ? new Date() : null);
  const [eventCount, setEventCount] = useState<number>(0);

  async function fetchData(force = false) {
    try {
      const events = await getEvents(undefined, EVENT_LIMIT);
      const outcomeEvents = (events as unknown[]).filter(
        (ev) => (ev as WsMessage).topic?.startsWith("autonomous.outcome.")
      );
      setEventCount(outcomeEvents.length);
      setRows(aggregateRows(events as unknown[]));
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData(true);
    const timer = setInterval(() => fetchData(true), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  // Summary totals
  const totalOutcomes = rows.reduce((s, r) => s + r.total, 0);
  const totalSuccesses = rows.reduce((s, r) => s + r.successCount, 0);
  const totalCost = rows.reduce((s, r) => s + r.totalCostUsd, 0);
  const fleetCostPerOutcome =
    totalSuccesses > 0 ? totalCost / totalSuccesses : 0;

  return (
    <div class="fleet-cost">
      <div class="fleet-cost__header">
        <div>
          <h2 class="fleet-cost__title">Fleet Cost per Outcome</h2>
          <p class="fleet-cost__subtitle">
            Cost-per-successful-outcome per agent per skill — last {EVENT_LIMIT} bus events
          </p>
        </div>
        {lastUpdated && (
          <span class="fleet-cost__updated">
            Updated {lastUpdated.toLocaleTimeString()} · {eventCount} outcome events
          </span>
        )}
      </div>

      {loading && (
        <div class="card">
          <p class="placeholder-content">Loading fleet cost data…</p>
        </div>
      )}

      {!loading && error && (
        <div class="card" style={{ borderColor: "rgba(248,81,73,0.4)" }}>
          <p style={{ color: "var(--text-danger)", fontSize: "13px" }}>
            Failed to load events: {error}
          </p>
        </div>
      )}

      {!loading && !error && (
        <>
          <div class="fleet-cost__summary">
            <div class="fleet-cost__stat-card card">
              <span class="fleet-cost__stat-label">Total Outcomes</span>
              <span class="fleet-cost__stat-value">{totalOutcomes}</span>
            </div>
            <div class="fleet-cost__stat-card card">
              <span class="fleet-cost__stat-label">Successful</span>
              <span class="fleet-cost__stat-value" style={{ color: "var(--text-success)" }}>
                {totalSuccesses}
              </span>
            </div>
            <div class="fleet-cost__stat-card card">
              <span class="fleet-cost__stat-label">Total Cost</span>
              <span class="fleet-cost__stat-value">{formatCost(totalCost)}</span>
            </div>
            <div class="fleet-cost__stat-card card">
              <span class="fleet-cost__stat-label">Fleet $/Success</span>
              <span class="fleet-cost__stat-value" style={{ color: "var(--accent-fg)" }}>
                {formatCost(fleetCostPerOutcome)}
              </span>
            </div>
          </div>

          <div class="card fleet-cost__table-card">
            <div class="card-title">Cost per Agent × Skill</div>
            {rows.length === 0 ? (
              <p class="placeholder-content" style={{ padding: "24px" }}>
                No autonomous.outcome.# events in the last {EVENT_LIMIT} bus events
              </p>
            ) : (
              <div class="fleet-cost__table-wrapper">
                <table class="fleet-cost__table">
                  <thead>
                    <tr>
                      <th>Agent</th>
                      <th>Skill</th>
                      <th class="num">Total</th>
                      <th class="num">Success</th>
                      <th class="num">Failure</th>
                      <th class="num">Success Rate</th>
                      <th class="num">Total Cost</th>
                      <th class="num">$/Success</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={`${row.agent}-${row.skill}`}>
                        <td class="fleet-cost__td-agent">
                          <code>{row.agent}</code>
                        </td>
                        <td class="fleet-cost__td-skill">
                          <code>{row.skill}</code>
                        </td>
                        <td class="num">{row.total}</td>
                        <td class="num" style={{ color: "var(--text-success)" }}>
                          {row.successCount}
                        </td>
                        <td class="num" style={{ color: row.failureCount > 0 ? "var(--text-danger)" : "var(--text-secondary)" }}>
                          {row.failureCount}
                        </td>
                        <td
                          class="num"
                          style={{
                            color: successRateColor(row.successRate, row.total),
                            fontWeight: 600,
                          }}
                        >
                          {row.total < 3 ? "—" : `${(row.successRate * 100).toFixed(0)}%`}
                        </td>
                        <td class="num mono">{formatCost(row.totalCostUsd)}</td>
                        <td
                          class="num mono"
                          style={{
                            fontWeight: 600,
                            color: row.successCount > 0 ? "var(--accent-fg)" : "var(--text-secondary)",
                          }}
                        >
                          {row.successCount === 0 ? "—" : formatCost(row.costPerSuccessfulOutcome)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      <style>{`
        .fleet-cost {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .fleet-cost__header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .fleet-cost__title {
          font-size: 16px;
          font-weight: 600;
          margin: 0 0 4px;
        }
        .fleet-cost__subtitle {
          font-size: 12px;
          color: var(--text-secondary);
          margin: 0;
        }
        .fleet-cost__updated {
          font-size: 11px;
          color: var(--text-muted);
          white-space: nowrap;
          padding-top: 4px;
        }
        .fleet-cost__summary {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .fleet-cost__stat-card {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 12px 16px;
          min-width: 100px;
          align-items: center;
        }
        .fleet-cost__stat-label {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .fleet-cost__stat-value {
          font-size: 22px;
          font-weight: 700;
          color: var(--text-primary);
          line-height: 1;
          font-variant-numeric: tabular-nums;
        }
        .fleet-cost__table-card {
          padding: 0;
          overflow: hidden;
        }
        .fleet-cost__table-card .card-title {
          padding: 12px 16px 0;
        }
        .fleet-cost__table-wrapper {
          overflow-x: auto;
        }
        .fleet-cost__table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }
        .fleet-cost__table th {
          text-align: left;
          padding: 8px 16px;
          color: var(--text-secondary);
          font-weight: 600;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          border-bottom: 1px solid var(--border-default);
          white-space: nowrap;
        }
        .fleet-cost__table th.num,
        .fleet-cost__table td.num {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        .fleet-cost__table td {
          padding: 8px 16px;
          border-bottom: 1px solid var(--border-muted);
          color: var(--text-primary);
          vertical-align: middle;
        }
        .fleet-cost__table tr:last-child td {
          border-bottom: none;
        }
        .fleet-cost__table tr:hover td {
          background: var(--bg-subtle);
        }
        .fleet-cost__td-agent code,
        .fleet-cost__td-skill code {
          font-size: 11px;
          color: var(--accent-fg);
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        }
        .mono {
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        }
      `}</style>
    </div>
  );
}
