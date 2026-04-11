import { useState, useEffect } from "preact/hooks";
<<<<<<< HEAD

const POLL_INTERVAL_MS = 30_000;

interface OutcomeSummary {
  success: number;
  failure: number;
  timeout: number;
  total: number;
}

interface OutcomeRecord {
  correlationId: string;
  actionId: string;
  goalId: string;
  status: "success" | "failure" | "timeout";
  startedAt: number;
  completedAt: number;
  durationMs: number;
  error?: string;
}

interface OutcomesApiResponse {
  summary: OutcomeSummary;
  recent: OutcomeRecord[];
}
=======
import { getOutcomes, peek, type OutcomesResponse } from "../lib/api";

const POLL_INTERVAL_MS = 30_000;

type OutcomeSummary = OutcomesResponse["summary"];
type OutcomeRecord = OutcomesResponse["recent"][number];
>>>>>>> origin/main

function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

const statusBadgeClass: Record<string, string> = {
  success: "badge badge-green",
  failure: "badge badge-red",
  timeout: "badge badge-yellow",
};

export default function OutcomesTable() {
<<<<<<< HEAD
  const [summary, setSummary] = useState<OutcomeSummary | null>(null);
  const [recent, setRecent] = useState<OutcomeRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  async function fetchOutcomes() {
    try {
      const res = await fetch("/api/outcomes");
      if (!res.ok) throw new Error(`/api/outcomes: ${res.status}`);
      const json = (await res.json()) as OutcomesApiResponse;
=======
  const cached = peek<OutcomesResponse>("/api/outcomes");
  const [summary, setSummary] = useState<OutcomeSummary | null>(cached?.summary ?? null);
  const [recent, setRecent] = useState<OutcomeRecord[]>(
    cached?.recent ? cached.recent.slice().reverse() : [],
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!cached);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(cached ? new Date() : null);

  async function fetchOutcomes(force = false) {
    try {
      const json = await getOutcomes(force);
>>>>>>> origin/main
      setSummary(json.summary ?? { success: 0, failure: 0, timeout: 0, total: 0 });
      setRecent(Array.isArray(json.recent) ? json.recent.slice().reverse() : []);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
<<<<<<< HEAD
    fetchOutcomes();
    const timer = setInterval(fetchOutcomes, POLL_INTERVAL_MS);
=======
    fetchOutcomes(true);
    const timer = setInterval(() => fetchOutcomes(true), POLL_INTERVAL_MS);
>>>>>>> origin/main
    return () => clearInterval(timer);
  }, []);

  const successRate =
    summary && summary.total > 0
      ? ((summary.success / summary.total) * 100).toFixed(1)
      : null;

  return (
    <div class="outcomes">
      <div class="outcomes__header">
        <h2 class="outcomes__title">Action Outcomes</h2>
        {lastUpdated && (
          <span class="outcomes__updated">
            Updated {lastUpdated.toLocaleTimeString()}
          </span>
        )}
      </div>

      {loading && (
        <div class="card">
          <p class="placeholder-content">Loading outcomes…</p>
        </div>
      )}

      {!loading && error && (
        <div class="card" style={{ borderColor: "rgba(248,81,73,0.4)" }}>
          <p style={{ color: "var(--text-danger)", fontSize: "13px" }}>
            Failed to load outcomes: {error}
          </p>
        </div>
      )}

      {!loading && !error && summary && (
        <>
          <div class="outcomes__summary">
            <div class="outcomes__stat-card card">
              <span class="outcomes__stat-label">Total</span>
              <span class="outcomes__stat-value">{summary.total}</span>
            </div>
            <div class="outcomes__stat-card card">
              <span class="outcomes__stat-label">Success</span>
              <span class="outcomes__stat-value" style={{ color: "var(--text-success)" }}>
                {summary.success}
              </span>
            </div>
            <div class="outcomes__stat-card card">
              <span class="outcomes__stat-label">Failure</span>
              <span class="outcomes__stat-value" style={{ color: "var(--text-danger)" }}>
                {summary.failure}
              </span>
            </div>
            <div class="outcomes__stat-card card">
              <span class="outcomes__stat-label">Timeout</span>
              <span class="outcomes__stat-value" style={{ color: "var(--text-warning)" }}>
                {summary.timeout}
              </span>
            </div>
            {successRate !== null && (
              <div class="outcomes__stat-card card">
                <span class="outcomes__stat-label">Success Rate</span>
                <span
                  class="outcomes__stat-value"
                  style={{
                    color:
                      Number(successRate) >= 70
                        ? "var(--text-success)"
                        : Number(successRate) >= 40
                          ? "var(--text-warning)"
                          : "var(--text-danger)",
                  }}
                >
                  {successRate}%
                </span>
              </div>
            )}
          </div>

          <div class="card outcomes__table-card">
            <div class="card-title">Recent Dispatches</div>
            {recent.length === 0 ? (
              <p class="placeholder-content" style={{ padding: "24px" }}>
                No outcomes recorded yet
              </p>
            ) : (
              <div class="outcomes__table-wrapper">
                <table class="outcomes__table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Action</th>
                      <th>Goal</th>
                      <th>Status</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((row) => (
                      <tr key={row.correlationId}>
                        <td class="outcomes__td-time">
                          {formatTimestamp(row.startedAt)}
                        </td>
                        <td class="outcomes__td-action">
                          <code>{row.actionId}</code>
                        </td>
                        <td class="outcomes__td-goal">
                          <code>{row.goalId}</code>
                        </td>
                        <td>
                          <span class={statusBadgeClass[row.status] ?? "badge badge-blue"}>
                            {row.status}
                          </span>
                        </td>
                        <td class="outcomes__td-duration">
                          {formatDuration(row.durationMs)}
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
        .outcomes {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .outcomes__header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .outcomes__title {
          font-size: 16px;
          font-weight: 600;
        }
        .outcomes__updated {
          font-size: 12px;
          color: var(--text-secondary);
        }
        .outcomes__summary {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .outcomes__stat-card {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 12px 16px;
          min-width: 80px;
          align-items: center;
        }
        .outcomes__stat-label {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .outcomes__stat-value {
          font-size: 24px;
          font-weight: 700;
          color: var(--text-primary);
          line-height: 1;
        }
        .outcomes__table-card {
          padding: 0;
          overflow: hidden;
        }
        .outcomes__table-card .card-title {
          padding: 12px 16px 0;
        }
        .outcomes__table-wrapper {
          overflow-x: auto;
        }
        .outcomes__table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }
        .outcomes__table th {
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
        .outcomes__table td {
          padding: 8px 16px;
          border-bottom: 1px solid var(--border-muted);
          color: var(--text-primary);
          vertical-align: middle;
        }
        .outcomes__table tr:last-child td {
          border-bottom: none;
        }
        .outcomes__table tr:hover td {
          background: var(--bg-subtle);
        }
        .outcomes__td-time {
          white-space: nowrap;
          color: var(--text-secondary) !important;
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        }
        .outcomes__td-action code,
        .outcomes__td-goal code {
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
          color: var(--accent-fg);
          font-size: 11px;
        }
        .outcomes__td-duration {
          white-space: nowrap;
          color: var(--text-secondary) !important;
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        }
      `}</style>
    </div>
  );
}
