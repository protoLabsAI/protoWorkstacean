/**
 * SkillTrace — vertical waterfall view of a single correlationId's full
 * causal chain across the bus. Fetches from /api/bus/history and renders
 * the message sequence with relative timestamps so an operator can see
 * an entire skill dispatch (inbound → router → dispatcher → executor →
 * activity → response) at a glance, then click through to Langfuse for
 * the LLM-call detail when needed.
 *
 * URL form: /system/trace/<correlationId>
 *
 * Backend contract: GET /api/bus/history?correlationId=... → {
 *   success: true,
 *   data: { correlationId, count, messages: BusMessage[], stats }
 * }
 */

import { useEffect, useMemo, useState } from "react";

interface BusMessage {
  id: string;
  correlationId: string;
  topic: string;
  timestamp: number;
  payload?: Record<string, unknown>;
  source?: { interface?: string };
}

interface HistoryResponse {
  success: boolean;
  data?: {
    correlationId: string;
    count: number;
    messages: BusMessage[];
    stats: { size: number; capacity: number; ttlMs: number };
  };
  error?: string;
}

export default function SkillTrace() {
  const [correlationId, setCorrelationId] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("correlationId") ?? "";
  });
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState(correlationId);

  useEffect(() => {
    if (!correlationId) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/bus/history?correlationId=${encodeURIComponent(correlationId)}`)
      .then(r => r.json())
      .then((j: HistoryResponse) => {
        if (cancelled) return;
        if (!j.success) {
          setError(j.error ?? "unknown error");
        } else {
          setData(j);
        }
      })
      .catch(err => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [correlationId]);

  const messages = data?.data?.messages ?? [];
  const t0 = messages[0]?.timestamp ?? 0;

  const langfuseUrl = useMemo(() => {
    const base = (import.meta.env.PUBLIC_LANGFUSE_URL ?? "https://cloud.langfuse.com").replace(/\/$/, "");
    return `${base}/traces?search=${encodeURIComponent(correlationId)}`;
  }, [correlationId]);

  const search = (
    <form
      className="trace-search"
      onSubmit={(e) => {
        e.preventDefault();
        const next = inputValue.trim();
        if (!next || next === correlationId) return;
        // Push state so back-button works.
        const url = new URL(window.location.href);
        url.searchParams.set("correlationId", next);
        window.history.pushState({}, "", url.toString());
        setCorrelationId(next);
      }}
    >
      <input
        type="text"
        placeholder="correlationId"
        value={inputValue}
        onChange={(e) => setInputValue(e.currentTarget.value)}
      />
      <button type="submit">Trace</button>
    </form>
  );

  if (!correlationId) {
    return (
      <div className="skill-trace">
        <header className="trace-header">
          <h2>Skill trace</h2>
          {search}
        </header>
        <p className="trace-empty">
          Paste a correlationId to load every bus message under it. Trace
          history lives in memory for 30 minutes after the messages fire.
        </p>
        <style>{TRACE_STYLES}</style>
      </div>
    );
  }

  if (loading) {
    return <div className="trace-empty">Loading trace for {correlationId}…</div>;
  }
  if (error) {
    return (
      <div className="trace-empty trace-error">
        <h3>Trace lookup failed</h3>
        <p>{error}</p>
        <p>
          The bus history buffer is in-memory and capped at the recorder's TTL
          (30 minutes by default). If this correlation is older than that
          window, it's been pruned.
        </p>
      </div>
    );
  }
  if (messages.length === 0) {
    return (
      <div className="trace-empty">
        <h3>No bus messages for {correlationId}</h3>
        <p>Either the id is wrong, no traffic ran under it, or the entry
          aged out of the 30-min ring.</p>
      </div>
    );
  }

  return (
    <div className="skill-trace">
      <header className="trace-header">
        <div>
          <h2>Trace · <code>{correlationId}</code></h2>
          <p className="trace-meta">
            {messages.length} message{messages.length === 1 ? "" : "s"} ·
            spans {((messages[messages.length - 1].timestamp - t0) / 1000).toFixed(2)}s
          </p>
        </div>
        {search}
        <a className="langfuse-link" href={langfuseUrl} target="_blank" rel="noreferrer">
          Open in Langfuse →
        </a>
      </header>

      <ol className="trace-list">
        {messages.map((m) => {
          const isOpen = expanded === m.id;
          return (
            <li className="trace-row" key={m.id}>
              <button
                className="trace-row-toggle"
                onClick={() => setExpanded(isOpen ? null : m.id)}
                aria-expanded={isOpen}
              >
                <span className="trace-ts">+{((m.timestamp - t0) / 1000).toFixed(3)}s</span>
                <span className="trace-topic">{m.topic}</span>
                <span className="trace-source">{m.source?.interface ?? "-"}</span>
              </button>
              {isOpen && (
                <pre className="trace-payload">{JSON.stringify(m.payload ?? {}, null, 2)}</pre>
              )}
            </li>
          );
        })}
      </ol>

      <style>{TRACE_STYLES}</style>
    </div>
  );
}

const TRACE_STYLES = `
        .skill-trace {
          padding: 1.5rem;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
          color: #c9d1d9;
          background: #0d1117;
          min-height: 100%;
        }
        .trace-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 1rem;
          padding-bottom: 0.75rem;
          border-bottom: 1px solid #21262d;
        }
        .trace-header h2 {
          margin: 0;
          font-size: 1.1rem;
        }
        .trace-meta {
          margin: 0.25rem 0 0;
          color: #8b949e;
          font-size: 0.85rem;
        }
        .langfuse-link {
          padding: 0.4rem 0.75rem;
          background: #21262d;
          color: #58a6ff;
          text-decoration: none;
          border-radius: 4px;
          font-size: 0.85rem;
        }
        .langfuse-link:hover {
          background: #30363d;
        }
        .trace-empty {
          padding: 2rem;
          color: #8b949e;
          font-family: ui-monospace, monospace;
        }
        .trace-error h3 { color: #f85149; }
        .trace-list {
          list-style: none;
          padding: 0;
          margin: 0;
        }
        .trace-row {
          border-left: 2px solid #30363d;
          padding-left: 0.75rem;
          margin-bottom: 0.5rem;
        }
        .trace-row-toggle {
          display: grid;
          grid-template-columns: 5rem 1fr 6rem;
          gap: 0.75rem;
          width: 100%;
          background: transparent;
          color: inherit;
          border: none;
          padding: 0.4rem 0;
          font-family: inherit;
          font-size: 0.85rem;
          text-align: left;
          cursor: pointer;
        }
        .trace-row-toggle:hover {
          background: #161b22;
        }
        .trace-ts { color: #8b949e; }
        .trace-topic { color: #58a6ff; }
        .trace-source { color: #7ee787; text-align: right; }
        .trace-payload {
          background: #161b22;
          color: #c9d1d9;
          padding: 0.75rem;
          margin: 0.25rem 0 0;
          border-radius: 4px;
          font-size: 0.8rem;
          overflow-x: auto;
          max-height: 400px;
          overflow-y: auto;
        }
        .trace-search {
          display: flex;
          gap: 0.5rem;
        }
        .trace-search input {
          background: #0d1117;
          color: #c9d1d9;
          border: 1px solid #30363d;
          padding: 0.4rem 0.6rem;
          border-radius: 4px;
          font-family: inherit;
          font-size: 0.85rem;
          min-width: 18rem;
        }
        .trace-search button {
          background: #238636;
          color: white;
          border: none;
          padding: 0.4rem 0.9rem;
          border-radius: 4px;
          font-size: 0.85rem;
          cursor: pointer;
        }
        .trace-search button:hover { background: #2ea043; }
`;
