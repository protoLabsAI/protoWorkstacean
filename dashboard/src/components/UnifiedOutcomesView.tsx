import { useState, useEffect, useCallback } from "preact/hooks";
import { topicMatchesFilter } from "../lib/topic-filter";
import type { WsMessage } from "../lib/websocket";

const POLL_INTERVAL_MS = 15_000;
const TOPIC_PREFIX = "autonomous.outcome.#";
const EVENTS_LIMIT = 500;

interface OutcomeEvent {
  id?: string;
  topic: string;
  timestamp: string;
  systemActor: string;
  skill: string;
  success: boolean;
  durationMs: number;
  error?: string;
  textPreview?: string;
  correlationId: string;
  actionId?: string;
  goalId?: string;
}

function parseTopicSegments(topic: string): { systemActor: string; skill: string } {
  // Topic pattern: autonomous.outcome.{systemActor}.{skill}
  const parts = topic.split(".");
  // parts[0]=autonomous, parts[1]=outcome, parts[2]=systemActor, parts[3+]=skill
  const systemActor = parts[2] ?? "unknown";
  const skill = parts.slice(3).join(".") || "unknown";
  return { systemActor, skill };
}

function parseOutcomeEvent(msg: WsMessage): OutcomeEvent | null {
  if (!topicMatchesFilter(msg.topic, TOPIC_PREFIX)) return null;
  const p = msg.payload as Record<string, unknown> | null;
  if (!p || typeof p !== "object") return null;

  const { systemActor, skill } = parseTopicSegments(msg.topic);

  return {
    id: msg.id,
    topic: msg.topic,
    timestamp: msg.timestamp,
    systemActor: typeof p.systemActor === "string" ? p.systemActor : systemActor,
    skill: typeof p.skill === "string" ? p.skill : skill,
    success: p.success === true,
    durationMs: typeof p.durationMs === "number" ? p.durationMs : 0,
    error: typeof p.error === "string" ? p.error : undefined,
    textPreview: typeof p.textPreview === "string" ? p.textPreview : undefined,
    correlationId: typeof p.correlationId === "string" ? p.correlationId : msg.id ?? "",
    actionId: typeof p.actionId === "string" ? p.actionId : undefined,
    goalId: typeof p.goalId === "string" ? p.goalId : undefined,
  };
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

const ACTOR_COLORS: Record<string, string> = {
  goap: "badge badge-blue",
  ceremony: "badge badge-purple",
  faf: "badge badge-yellow",
  user: "badge badge-green",
};

function actorBadgeClass(actor: string): string {
  return ACTOR_COLORS[actor] ?? "badge";
}

export default function UnifiedOutcomesView() {
  const [allEvents, setAllEvents] = useState<OutcomeEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Filter state
  const [actorFilter, setActorFilter] = useState<string>("all");
  const [skillFilter, setSkillFilter] = useState<string>("");

  const fetchEvents = useCallback(async () => {
    try {
      const res = await fetch(`/api/events?limit=${EVENTS_LIMIT}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const raw = (await res.json()) as unknown;
      const msgs = (Array.isArray(raw) ? raw : []) as WsMessage[];
      const outcomes = msgs
        .map(parseOutcomeEvent)
        .filter((e): e is OutcomeEvent => e !== null)
        .reverse(); // newest first
      setAllEvents(outcomes);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
    const timer = setInterval(fetchEvents, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchEvents]);

  // Derived state
  const uniqueActors = Array.from(new Set(allEvents.map((e) => e.systemActor))).sort();

  const filtered = allEvents.filter((e) => {
    if (actorFilter !== "all" && e.systemActor !== actorFilter) return false;
    if (skillFilter && !e.skill.toLowerCase().includes(skillFilter.toLowerCase())) return false;
    return true;
  });

  // Summary stats across all (not filtered)
  const summary = allEvents.reduce(
    (acc, e) => {
      acc.total += 1;
      if (e.success) acc.success += 1;
      else acc.failure += 1;
      return acc;
    },
    { total: 0, success: 0, failure: 0 },
  );

  const successRate =
    summary.total > 0 ? ((summary.success / summary.total) * 100).toFixed(1) : null;

  return (
    <div class="uov">
      <div class="uov__header">
        <div>
          <h2 class="uov__title">Unified Outcomes</h2>
          <p class="uov__subtitle">
            All autonomous outcomes — GOAP, ceremony, FAF, and ad-hoc dispatches.
          </p>
        </div>
        {lastUpdated && (
          <span class="uov__updated">Updated {lastUpdated.toLocaleTimeString()}</span>
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

      {!loading && !error && (
        <>
          {/* Summary stats */}
          <div class="uov__summary">
            <div class="uov__stat card">
              <span class="uov__stat-label">Total</span>
              <span class="uov__stat-value">{summary.total}</span>
            </div>
            <div class="uov__stat card">
              <span class="uov__stat-label">Success</span>
              <span class="uov__stat-value" style={{ color: "var(--text-success)" }}>
                {summary.success}
              </span>
            </div>
            <div class="uov__stat card">
              <span class="uov__stat-label">Failure</span>
              <span class="uov__stat-value" style={{ color: "var(--text-danger)" }}>
                {summary.failure}
              </span>
            </div>
            {successRate !== null && (
              <div class="uov__stat card">
                <span class="uov__stat-label">Success Rate</span>
                <span
                  class="uov__stat-value"
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

          {/* Filter facets */}
          <div class="uov__filters card">
            <div class="uov__filter-group">
              <span class="uov__filter-label">System Actor</span>
              <div class="uov__facets">
                <button
                  class={`uov__facet ${actorFilter === "all" ? "uov__facet--active" : ""}`}
                  onClick={() => setActorFilter("all")}
                >
                  All
                </button>
                {uniqueActors.map((actor) => (
                  <button
                    key={actor}
                    class={`uov__facet ${actorFilter === actor ? "uov__facet--active" : ""}`}
                    onClick={() => setActorFilter(actor)}
                  >
                    {actor}
                  </button>
                ))}
              </div>
            </div>
            <div class="uov__filter-group">
              <span class="uov__filter-label">Skill</span>
              <input
                type="text"
                class="uov__search"
                placeholder="Filter by skill…"
                value={skillFilter}
                onInput={(e) => setSkillFilter((e.target as HTMLInputElement).value)}
              />
            </div>
          </div>

          {/* Outcome list */}
          <div class="card uov__table-card">
            <div class="card-title">
              Recent Outcomes
              {filtered.length !== allEvents.length && (
                <span class="uov__count"> — {filtered.length} of {allEvents.length}</span>
              )}
            </div>
            {filtered.length === 0 ? (
              <p class="placeholder-content" style={{ padding: "24px" }}>
                {allEvents.length === 0
                  ? "No autonomous outcomes recorded yet"
                  : "No outcomes match the current filters"}
              </p>
            ) : (
              <div class="uov__table-wrapper">
                <table class="uov__table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>System Actor</th>
                      <th>Skill</th>
                      <th>Status</th>
                      <th class="num">Duration</th>
                      <th>Preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((row) => (
                      <tr key={row.correlationId || row.id}>
                        <td class="uov__td-time">{formatTimestamp(row.timestamp)}</td>
                        <td>
                          <span class={actorBadgeClass(row.systemActor)}>{row.systemActor}</span>
                        </td>
                        <td>
                          <code class="uov__skill">{row.skill}</code>
                        </td>
                        <td>
                          {row.success ? (
                            <span class="badge badge-green">success</span>
                          ) : (
                            <span class="badge badge-red">failure</span>
                          )}
                        </td>
                        <td class="num uov__td-duration">{formatDuration(row.durationMs)}</td>
                        <td class="uov__td-preview">
                          {row.error ? (
                            <span class="uov__error">{row.error.slice(0, 80)}</span>
                          ) : row.textPreview ? (
                            <span class="uov__preview">{row.textPreview.slice(0, 80)}</span>
                          ) : null}
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
        .uov {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .uov__header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .uov__title {
          font-size: 16px;
          font-weight: 600;
          color: var(--text-primary);
          margin: 0 0 2px;
        }
        .uov__subtitle {
          font-size: 12px;
          color: var(--text-secondary);
          margin: 0;
        }
        .uov__updated {
          font-size: 12px;
          color: var(--text-secondary);
          white-space: nowrap;
          flex-shrink: 0;
        }
        .uov__summary {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .uov__stat {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 12px 16px;
          min-width: 80px;
          align-items: center;
        }
        .uov__stat-label {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .uov__stat-value {
          font-size: 24px;
          font-weight: 700;
          color: var(--text-primary);
          line-height: 1;
        }
        .uov__filters {
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 12px 16px;
        }
        .uov__filter-group {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }
        .uov__filter-label {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          min-width: 80px;
        }
        .uov__facets {
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .uov__facet {
          font-size: 12px;
          padding: 3px 10px;
          border-radius: 12px;
          border: 1px solid var(--border-default);
          background: var(--bg-canvas);
          color: var(--text-secondary);
          cursor: pointer;
          transition: all 0.1s;
          font-family: inherit;
        }
        .uov__facet:hover {
          background: var(--bg-subtle);
          color: var(--text-primary);
        }
        .uov__facet--active {
          background: var(--accent-emphasis);
          color: #ffffff;
          border-color: var(--accent-emphasis);
        }
        .uov__facet--active:hover {
          background: var(--accent-emphasis);
          color: #ffffff;
        }
        .uov__search {
          font-size: 12px;
          padding: 4px 10px;
          border-radius: 6px;
          border: 1px solid var(--border-default);
          background: var(--bg-canvas);
          color: var(--text-primary);
          outline: none;
          width: 200px;
          font-family: inherit;
        }
        .uov__search:focus {
          border-color: var(--accent-fg);
        }
        .uov__table-card {
          padding: 0;
          overflow: hidden;
        }
        .uov__table-card .card-title {
          padding: 12px 16px 0;
        }
        .uov__count {
          font-weight: 400;
          color: var(--text-secondary);
          font-size: 12px;
        }
        .uov__table-wrapper {
          overflow-x: auto;
        }
        .uov__table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }
        .uov__table th {
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
        .uov__table th.num,
        .uov__table td.num {
          text-align: right;
          font-variant-numeric: tabular-nums;
        }
        .uov__table td {
          padding: 8px 16px;
          border-bottom: 1px solid var(--border-muted);
          color: var(--text-primary);
          vertical-align: middle;
        }
        .uov__table tr:last-child td {
          border-bottom: none;
        }
        .uov__table tr:hover td {
          background: var(--bg-subtle);
        }
        .uov__td-time {
          white-space: nowrap;
          color: var(--text-secondary) !important;
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        }
        .uov__skill {
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
          color: var(--accent-fg);
          font-size: 11px;
        }
        .uov__td-duration {
          white-space: nowrap;
          color: var(--text-secondary) !important;
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        }
        .uov__td-preview {
          max-width: 300px;
        }
        .uov__error {
          color: var(--text-danger);
          font-size: 11px;
        }
        .uov__preview {
          color: var(--text-secondary);
          font-size: 11px;
        }
        .badge-purple {
          background: rgba(130, 80, 255, 0.15);
          color: #a78bfa;
          border: 1px solid rgba(130, 80, 255, 0.3);
        }
      `}</style>
    </div>
  );
}
