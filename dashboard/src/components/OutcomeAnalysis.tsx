import { useState, useEffect } from "preact/hooks";
import { getOutcomesAnalysis, peek, type OutcomesAnalysisResponse } from "../lib/api";

const POLL_INTERVAL_MS = 60_000;

type ActionStat = OutcomesAnalysisResponse["data"]["actions"][number];
type HitlStat = OutcomesAnalysisResponse["data"]["hitl"][number];

function successRateColor(rate: number, total: number): string {
  if (total < 10) return "var(--text-muted)"; // insufficient data
  if (rate >= 0.7) return "var(--text-success)";
  if (rate >= 0.5) return "var(--text-warning)";
  return "var(--text-danger)";
}

function formatAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3600_000)}h ago`;
}

export default function OutcomeAnalysis() {
  const cached = peek<OutcomesAnalysisResponse>("/api/outcomes/analysis");
  const [actions, setActions] = useState<ActionStat[]>(cached?.data?.actions ?? []);
  const [hitl, setHitl] = useState<HitlStat[]>(cached?.data?.hitl ?? []);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!cached);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(cached ? new Date() : null);

  async function fetchData(force = false) {
    try {
      const json = await getOutcomesAnalysis(force);
      if (json.success) {
        setActions(json.data?.actions ?? []);
        setHitl(json.data?.hitl ?? []);
        setError(null);
      } else {
        setError("outcome-analysis plugin not available");
      }
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

  // Sort actions: worst success rate first (but only among actions with enough data)
  const sortedActions = [...actions].sort((a, b) => {
    const aSignificant = a.total >= 10;
    const bSignificant = b.total >= 10;
    if (aSignificant !== bSignificant) return aSignificant ? -1 : 1;
    return a.successRate - b.successRate;
  });

  return (
    <div class="outcome-analysis">
      <div class="outcome-analysis__header">
        <h2 class="outcome-analysis__title">Outcome Analysis</h2>
        {lastUpdated && (
          <span class="outcome-analysis__updated">
            Updated {lastUpdated.toLocaleTimeString()}
          </span>
        )}
      </div>

      {loading && (
        <div class="card">
          <p class="placeholder-content">Loading analysis…</p>
        </div>
      )}

      {!loading && error && (
        <div class="card" style={{ borderColor: "rgba(248,81,73,0.4)" }}>
          <p style={{ color: "var(--text-danger)", fontSize: "13px" }}>
            {error}
          </p>
        </div>
      )}

      {!loading && !error && (
        <>
          <div class="card outcome-analysis__table-card">
            <div class="card-title">Action Success Rates</div>
            <p class="placeholder-content" style={{ padding: "0 16px 8px", fontSize: "12px" }}>
              Actions flagged when success rate &lt; 50% over 10+ attempts. Chronic failures surface to Discord as <code>ops.alert.action_quality</code>.
            </p>
            {sortedActions.length === 0 ? (
              <p class="placeholder-content" style={{ padding: "24px" }}>
                No action outcomes recorded yet
              </p>
            ) : (
              <div class="outcome-analysis__table-wrapper">
                <table class="outcome-analysis__table">
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th class="num">Success Rate</th>
                      <th class="num">Total</th>
                      <th class="num">Success</th>
                      <th class="num">Failure</th>
                      <th class="num">Timeout</th>
                      <th>Last Run</th>
                      <th>Flagged</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedActions.map((row) => (
                      <tr key={row.actionId}>
                        <td><code>{row.actionId}</code></td>
                        <td
                          class="num"
                          style={{
                            color: successRateColor(row.successRate, row.total),
                            fontWeight: 600,
                          }}
                        >
                          {(row.successRate * 100).toFixed(0)}%
                        </td>
                        <td class="num">{row.total}</td>
                        <td class="num" style={{ color: "var(--text-success)" }}>{row.success}</td>
                        <td class="num" style={{ color: "var(--text-danger)" }}>{row.failure}</td>
                        <td class="num" style={{ color: "var(--text-warning)" }}>{row.timeout}</td>
                        <td>{formatAgo(row.lastEvaluatedAt)}</td>
                        <td>
                          {row.alertedAt ? (
                            <span class="badge badge-red">alerted</span>
                          ) : row.total >= 10 && row.successRate < 0.5 ? (
                            <span class="badge badge-yellow">at risk</span>
                          ) : row.total < 10 ? (
                            <span class="badge">gathering</span>
                          ) : (
                            <span class="badge badge-green">healthy</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div class="card outcome-analysis__table-card" style={{ marginTop: 16 }}>
            <div class="card-title">HITL Escalation Clusters</div>
            <p class="placeholder-content" style={{ padding: "0 16px 8px", fontSize: "12px" }}>
              Repeated human-needed actions surface as feature-request signals — "what capability would unblock this automatically?"
            </p>
            {hitl.length === 0 ? (
              <p class="placeholder-content" style={{ padding: "24px" }}>
                No HITL escalations clustered yet
              </p>
            ) : (
              <div class="outcome-analysis__table-wrapper">
                <table class="outcome-analysis__table">
                  <thead>
                    <tr>
                      <th>Kind</th>
                      <th>Target</th>
                      <th class="num">Count</th>
                      <th>First Seen</th>
                      <th>Last Seen</th>
                      <th>Flagged</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hitl.map((row) => (
                      <tr key={`${row.kind}-${row.target}`}>
                        <td><code>{row.kind}</code></td>
                        <td><code>{row.target}</code></td>
                        <td class="num" style={{ fontWeight: 600 }}>{row.count}</td>
                        <td>{formatAgo(row.firstSeenAt)}</td>
                        <td>{formatAgo(row.lastSeenAt)}</td>
                        <td>
                          {row.alertedAt ? (
                            <span class="badge badge-red">alerted</span>
                          ) : row.count >= 3 ? (
                            <span class="badge badge-yellow">at threshold</span>
                          ) : (
                            <span class="badge">watching</span>
                          )}
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
        .outcome-analysis__header {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          margin-bottom: 16px;
        }
        .outcome-analysis__title {
          font-size: 16px;
          font-weight: 600;
          color: var(--text-primary);
          margin: 0;
        }
        .outcome-analysis__updated {
          font-size: 11px;
          color: var(--text-muted);
        }
        .outcome-analysis__table-wrapper {
          overflow-x: auto;
        }
        .outcome-analysis__table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }
        .outcome-analysis__table th {
          text-align: left;
          padding: 8px 16px;
          color: var(--text-secondary);
          font-weight: 600;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          border-bottom: 1px solid var(--border-default);
        }
        .outcome-analysis__table th.num,
        .outcome-analysis__table td.num {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        .outcome-analysis__table td {
          padding: 8px 16px;
          border-bottom: 1px solid var(--border-muted);
          color: var(--text-primary);
          vertical-align: middle;
        }
        .outcome-analysis__table tr:last-child td {
          border-bottom: none;
        }
        .outcome-analysis__table code {
          font-size: 11px;
          color: var(--text-secondary);
        }
      `}</style>
    </div>
  );
}
