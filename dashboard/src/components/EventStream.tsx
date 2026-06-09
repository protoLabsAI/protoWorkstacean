import { useState, useEffect, useRef } from "react";
import { WebSocketManager } from "../lib/websocket";
import type { WsMessage } from "../lib/websocket";
import { topicMatchesFilter } from "../lib/topic-filter";
import { EventRow } from "./EventRow";
import { LogRow } from "./LogRow";

type WsStatus = "connecting" | "connected" | "disconnected";

function isDebug(msg: WsMessage): boolean {
  return typeof msg.topic === "string" && msg.topic.startsWith("debug.");
}

export default function EventStream() {
  const [events, setEvents] = useState<WsMessage[]>([]);
  const [logs, setLogs] = useState<WsMessage[]>([]);
  const [activeTab, setActiveTab] = useState<"events" | "logs">("events");
  const [filter, setFilter] = useState("");
  const [isPaused, setIsPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [wsStatus, setWsStatus] = useState<WsStatus>("connecting");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const isPausedRef = useRef(isPaused);
  isPausedRef.current = isPaused;

  const autoScrollRef = useRef(autoScroll);
  autoScrollRef.current = autoScroll;

  // Load history on mount
  useEffect(() => {
    fetch("/api/events?limit=500")
      .then((r) => r.json())
      .then((data: unknown) => {
        const msgs = (Array.isArray(data) ? data : []) as WsMessage[];
        const evts: WsMessage[] = [];
        const lgts: WsMessage[] = [];
        msgs.reverse().forEach((msg) => {
          if (isDebug(msg)) lgts.push(msg);
          else evts.push(msg);
        });
        setEvents(evts);
        setLogs(lgts);
      })
      .catch(() => {});
  }, []);

  // WebSocket connection
  useEffect(() => {
    const manager = new WebSocketManager("/ws");

    const offStatus = manager.onStatus((status) => setWsStatus(status));
    const offMsg = manager.onMessage((msg) => {
      if (isPausedRef.current) return;
      if (isDebug(msg)) {
        setLogs((prev) => [...prev, msg]);
      } else {
        setEvents((prev) => [...prev, msg]);
      }
    });

    manager.connect();

    return () => {
      offStatus();
      offMsg();
      manager.destroy();
    };
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [events, logs, autoScroll]);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    if (atBottom !== autoScrollRef.current) {
      setAutoScroll(atBottom);
    }
  }

  function clearActive() {
    if (activeTab === "events") setEvents([]);
    else setLogs([]);
    setExpandedId(null);
  }

  function toggleExpanded(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  const items = activeTab === "events" ? events : logs;
  const filtered = filter
    ? items.filter((m) => topicMatchesFilter(m.topic, filter))
    : items;

  const dotClass =
    wsStatus === "connected"
      ? "status-dot connected"
      : wsStatus === "connecting"
        ? "status-dot connecting"
        : "status-dot";

  const statusLabel =
    wsStatus === "connected"
      ? "Connected"
      : wsStatus === "connecting"
        ? "Connecting…"
        : "Disconnected";

  return (
    <>
      <style>{`
        .es-root {
          display: flex;
          flex-direction: column;
          /* Fill the shell workspace row (chrome = topbar + utility bar) */
          min-height: calc(100vh - var(--shell-topbar-h) - var(--shell-utility-h));
          margin: -24px;
        }
        .es-sticky {
          position: sticky;
          top: -24px;
          z-index: 10;
          background: linear-gradient(180deg, var(--bg-default) 0%, var(--bg-default) 100%);
          border-bottom: 1px solid var(--border-default);
          box-shadow: 0 4px 12px -8px rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(8px);
        }
        .es-header {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 20px 10px 20px;
          flex-wrap: wrap;
          position: relative;
        }
        .es-header::before {
          content: "";
          position: absolute;
          left: 20px;
          top: 0;
          width: 3px;
          height: 100%;
          background: linear-gradient(180deg, var(--accent-fg) 0%, var(--accent-emphasis) 100%);
          border-radius: 0 0 2px 2px;
          opacity: 0.8;
        }
        .es-header-title {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
          letter-spacing: 0.3px;
          text-transform: uppercase;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .es-header-title::before {
          content: "◉";
          color: var(--accent-fg);
          font-size: 14px;
          animation: es-pulse-dot 2s ease-in-out infinite;
        }
        @keyframes es-pulse-dot {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.1); }
        }
        .es-tabs {
          display: flex;
          gap: 2px;
          background: var(--bg-canvas);
          border-radius: 6px;
          padding: 2px;
          border: 1px solid var(--border-muted);
        }
        .es-tab {
          padding: 5px 16px;
          font-size: 12px;
          border-radius: 4px;
          cursor: pointer;
          color: var(--text-secondary);
          border: none;
          background: transparent;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
          font-weight: 500;
          transition: all 0.15s;
        }
        .es-tab:hover { color: var(--text-primary); }
        .es-tab.active {
          background: var(--bg-subtle);
          color: var(--text-primary);
          box-shadow: 0 0 0 1px rgba(var(--accent-rgb), 0.2);
        }

        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--text-danger);
          transition: background 0.2s;
          flex-shrink: 0;
        }
        .status-dot.connected {
          background: var(--text-success);
          box-shadow: 0 0 6px rgba(var(--success-rgb), 0.6);
        }
        .status-dot.connecting { background: var(--text-warning); animation: es-pulse 1s infinite; }
        @keyframes es-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

        .es-status {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          padding: 4px 10px;
          border-radius: 12px;
          background: var(--bg-subtle);
          color: var(--text-primary);
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
          border: 1px solid var(--border-default);
        }
        .es-badge {
          font-size: 11px;
          background: var(--border-default);
          padding: 3px 10px;
          border-radius: 10px;
          color: var(--text-primary);
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
          font-weight: 500;
          margin-left: auto;
        }
        .es-toolbar {
          padding: 8px 20px 12px 20px;
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
        }
        .es-filter {
          background: var(--bg-canvas);
          border: 1px solid var(--border-default);
          color: var(--text-primary);
          padding: 6px 10px;
          border-radius: 6px;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
          font-size: 13px;
          width: 260px;
          outline: none;
        }
        .es-filter:focus { border-color: var(--accent-fg); }
        .es-filter::placeholder { color: var(--text-secondary); }
        .es-btn {
          background: var(--bg-subtle);
          border: 1px solid var(--border-default);
          color: var(--text-primary);
          padding: 6px 12px;
          border-radius: 6px;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
          font-size: 12px;
          cursor: pointer;
          transition: background 0.15s;
        }
        .es-btn:hover { background: var(--border-default); }
        .es-btn.active { background: var(--accent-emphasis); border-color: var(--accent-emphasis); }
        .es-btn.paused { background: var(--text-danger); border-color: var(--text-danger); }

        .es-list {
          flex: 1;
          overflow: auto;
          padding: 4px 0;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
        }
        .es-list::-webkit-scrollbar { width: 8px; }
        .es-list::-webkit-scrollbar-track { background: var(--bg-canvas); }
        .es-list::-webkit-scrollbar-thumb { background: var(--border-default); border-radius: 4px; }

        .es-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 200px;
          color: var(--text-secondary);
          gap: 8px;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
          font-size: 14px;
        }

        /* Event rows */
        .event-row {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 8px 16px;
          border-bottom: 1px solid var(--border-muted);
          cursor: pointer;
          transition: background 0.1s;
          overflow-x: auto;
        }
        .event-row:hover { background: var(--bg-default); }
        .event-time {
          font-size: 11px;
          color: var(--text-secondary);
          white-space: nowrap;
          min-width: 70px;
          padding-top: 2px;
        }
        .event-topic {
          font-size: 11px;
          padding: 2px 6px;
          border-radius: 4px;
          white-space: nowrap;
          font-weight: 500;
          letter-spacing: 0.5px;
        }
        .event-topic.source-agent { background: rgba(var(--accent-rgb), 0.12); color: var(--accent-fg); }
        .event-topic.source-cli { background: rgba(var(--success-rgb), 0.12); color: var(--text-success); }
        .event-topic.source-signal { background: rgba(var(--warning-rgb), 0.12); color: var(--text-warning); }
        .event-topic.source-echo { background: rgba(var(--accent-rgb), 0.12); color: var(--accent-fg); }
        .event-topic.source-scheduler { background: rgba(var(--accent-rgb), 0.12); color: var(--accent-fg); }
        .event-topic.source-logger { background: rgba(var(--accent-rgb), 0.12); color: var(--accent-fg); }
        .event-topic.source-event-viewer { background: rgba(var(--warning-rgb), 0.12); color: var(--text-warning); }
        .event-topic.source-default { background: var(--bg-subtle); color: var(--text-secondary); }
        .event-preview {
          font-size: 12px;
          color: var(--text-secondary);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
        }
        .event-detail {
          display: none;
          padding: 0 16px 12px 98px;
          background: var(--bg-canvas);
          border-bottom: 1px solid var(--border-muted);
        }
        .event-detail.open { display: block; }
        .event-detail pre {
          background: var(--bg-default);
          border: 1px solid var(--border-default);
          border-radius: 6px;
          padding: 12px;
          font-size: 12px;
          overflow: auto;
          max-height: 400px;
          color: var(--text-primary);
          line-height: 1.5;
        }
        .event-detail-toolbar {
          display: flex;
          gap: 6px;
          margin-bottom: 6px;
        }
        .detail-btn {
          background: var(--bg-subtle);
          border: 1px solid var(--border-default);
          color: var(--text-secondary);
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 11px;
          cursor: pointer;
          font-family: inherit;
        }
        .detail-btn:hover { background: var(--border-default); color: var(--text-primary); }

        /* Log rows */
        .log-row {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 4px 16px;
          border-bottom: 1px solid var(--bg-default);
          cursor: pointer;
          transition: background 0.1s;
        }
        .log-row:hover { background: var(--bg-default); }
        .log-level {
          font-size: 10px;
          padding: 1px 6px;
          border-radius: 3px;
          white-space: nowrap;
          font-weight: 600;
          text-transform: uppercase;
          min-width: 44px;
          text-align: center;
        }
        .log-level.log { background: var(--bg-subtle); color: var(--text-secondary); }
        .log-level.debug { background: rgba(var(--accent-rgb), 0.12); color: var(--accent-fg); }
        .log-level.info { background: rgba(var(--success-rgb), 0.12); color: var(--text-success); }
        .log-level.warn { background: rgba(var(--warning-rgb), 0.12); color: var(--text-warning); }
        .log-level.error { background: rgba(var(--danger-rgb), 0.12); color: var(--text-danger); }
        .log-message {
          font-size: 12px;
          color: var(--text-secondary);
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .log-detail {
          display: none;
          padding: 0 16px 12px 98px;
          background: var(--bg-canvas);
          border-bottom: 1px solid var(--bg-default);
        }
        .log-detail.open { display: block; }
        .log-detail pre {
          background: var(--bg-default);
          border: 1px solid var(--border-default);
          border-radius: 6px;
          padding: 12px;
          font-size: 12px;
          overflow: auto;
          max-height: 400px;
          color: var(--text-primary);
          line-height: 1.5;
        }
      `}</style>

      <div className="es-root">
        <div className="es-sticky">
          <div className="es-header">
            <div className="es-header-title">Event Stream</div>
            <div className="es-tabs">
              <button
                className={`es-tab${activeTab === "events" ? " active" : ""}`}
                onClick={() => { setActiveTab("events"); setExpandedId(null); }}
              >
                Events
              </button>
              <button
                className={`es-tab${activeTab === "logs" ? " active" : ""}`}
                onClick={() => { setActiveTab("logs"); setExpandedId(null); }}
              >
                Logs
              </button>
            </div>
            <div className="es-status">
              <span className={dotClass} />
              {statusLabel}
            </div>
            <div className="es-badge">
              {filtered.length} {activeTab === "events" ? "events" : "logs"}
            </div>
          </div>

          <div className="es-toolbar">
            <input
              className="es-filter"
              type="text"
              placeholder={activeTab === "events" ? "Filter by topic (e.g. agent.*)" : "Filter by topic (e.g. debug.*)"}
              value={filter}
              onChange={(e) => setFilter(e.currentTarget.value)}
            />
            <button className="es-btn" onClick={clearActive}>Clear</button>
            <button
              className={`es-btn${isPaused ? " paused" : ""}`}
              onClick={() => setIsPaused((p) => !p)}
            >
              {isPaused ? "Resume" : "Pause"}
            </button>
            <button
              className={`es-btn${autoScroll ? " active" : ""}`}
              onClick={() => setAutoScroll((a) => !a)}
              title="Toggle auto-scroll"
            >
              Auto-scroll
            </button>
          </div>
        </div>

        <div className="es-list" ref={listRef} onScroll={handleScroll}>
          {filtered.length === 0 ? (
            <div className="es-empty">
              <p>{items.length === 0 ? "Waiting for events…" : "No matches for current filter"}</p>
            </div>
          ) : (
            filtered.map((msg) =>
              activeTab === "events" ? (
                <EventRow
                  key={msg.id ?? msg.timestamp}
                  msg={msg}
                  isExpanded={expandedId === (msg.id ?? msg.timestamp)}
                  onClick={() => toggleExpanded(msg.id ?? msg.timestamp)}
                />
              ) : (
                <LogRow
                  key={msg.id ?? msg.timestamp}
                  msg={msg}
                  isExpanded={expandedId === (msg.id ?? msg.timestamp)}
                  onClick={() => toggleExpanded(msg.id ?? msg.timestamp)}
                />
              )
            )
          )}
        </div>
      </div>
    </>
  );
}
