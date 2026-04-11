import { useState, useEffect, useRef } from "preact/hooks";
import { WebSocketManager } from "../lib/websocket";
import type { WsMessage } from "../lib/websocket";
import { EventRow } from "./EventRow";
import { LogRow } from "./LogRow";

type WsStatus = "connecting" | "connected" | "disconnected";

// Wildcard topic filter — supports * (single segment) and # (any suffix)
function topicMatchesFilter(topic: string, filter: string): boolean {
  if (!filter) return true;
  const parts = filter.split(".");
  const topicParts = (topic || "").split(".");
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "#") return true;
    if (parts[i] === "*") continue;
    if (parts[i] !== topicParts[i]) return false;
  }
  return parts.length === topicParts.length;
}

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
<<<<<<< HEAD
=======
        .es-root {
          display: flex;
          flex-direction: column;
          /* Fill the main-content area (which has its own overflow) */
          min-height: calc(100vh - var(--header-height) - 48px);
          margin: -24px;
        }
        .es-sticky {
          position: sticky;
          top: -24px;
          z-index: 10;
          background: linear-gradient(180deg, #161b22 0%, #12161d 100%);
          border-bottom: 1px solid #30363d;
          box-shadow: 0 4px 12px -8px rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(8px);
        }
>>>>>>> origin/main
        .es-header {
          display: flex;
          align-items: center;
          gap: 12px;
<<<<<<< HEAD
          background: #161b22;
          border-bottom: 1px solid #30363d;
          padding: 10px 16px;
          flex-shrink: 0;
          flex-wrap: wrap;
=======
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
          background: linear-gradient(180deg, #58a6ff 0%, #1f6feb 100%);
          border-radius: 0 0 2px 2px;
          opacity: 0.8;
        }
        .es-header-title {
          font-size: 13px;
          font-weight: 600;
          color: #c9d1d9;
          letter-spacing: 0.3px;
          text-transform: uppercase;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .es-header-title::before {
          content: "◉";
          color: #58a6ff;
          font-size: 14px;
          animation: es-pulse-dot 2s ease-in-out infinite;
        }
        @keyframes es-pulse-dot {
          0%, 100% { opacity: 0.4; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.1); }
>>>>>>> origin/main
        }
        .es-tabs {
          display: flex;
          gap: 2px;
          background: #0d1117;
          border-radius: 6px;
          padding: 2px;
<<<<<<< HEAD
        }
        .es-tab {
          padding: 4px 14px;
=======
          border: 1px solid #21262d;
        }
        .es-tab {
          padding: 5px 16px;
>>>>>>> origin/main
          font-size: 12px;
          border-radius: 4px;
          cursor: pointer;
          color: #8b949e;
          border: none;
          background: transparent;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
<<<<<<< HEAD
          transition: all 0.15s;
        }
        .es-tab:hover { color: #c9d1d9; }
        .es-tab.active { background: #21262d; color: #c9d1d9; }
=======
          font-weight: 500;
          transition: all 0.15s;
        }
        .es-tab:hover { color: #c9d1d9; }
        .es-tab.active {
          background: #21262d;
          color: #c9d1d9;
          box-shadow: 0 0 0 1px rgba(88, 166, 255, 0.2);
        }
>>>>>>> origin/main

        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #f85149;
          transition: background 0.2s;
          flex-shrink: 0;
        }
<<<<<<< HEAD
        .status-dot.connected { background: #3fb950; }
=======
        .status-dot.connected {
          background: #3fb950;
          box-shadow: 0 0 6px rgba(63, 185, 80, 0.6);
        }
>>>>>>> origin/main
        .status-dot.connecting { background: #d29922; animation: es-pulse 1s infinite; }
        @keyframes es-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

        .es-status {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          padding: 4px 10px;
          border-radius: 12px;
          background: #21262d;
          color: #c9d1d9;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
<<<<<<< HEAD
=======
          border: 1px solid #30363d;
>>>>>>> origin/main
        }
        .es-badge {
          font-size: 11px;
          background: #30363d;
<<<<<<< HEAD
          padding: 2px 8px;
          border-radius: 10px;
          color: #8b949e;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
        }
        .es-toolbar {
          background: #161b22;
          border-bottom: 1px solid #30363d;
          padding: 8px 16px;
          display: flex;
          gap: 8px;
          align-items: center;
          flex-shrink: 0;
=======
          padding: 3px 10px;
          border-radius: 10px;
          color: #c9d1d9;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
          font-weight: 500;
          margin-left: auto;
        }
        .es-toolbar {
          padding: 8px 20px 12px 20px;
          display: flex;
          gap: 8px;
          align-items: center;
>>>>>>> origin/main
          flex-wrap: wrap;
        }
        .es-filter {
          background: #0d1117;
          border: 1px solid #30363d;
          color: #c9d1d9;
          padding: 6px 10px;
          border-radius: 6px;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
          font-size: 13px;
          width: 260px;
          outline: none;
        }
        .es-filter:focus { border-color: #58a6ff; }
        .es-filter::placeholder { color: #484f58; }
        .es-btn {
          background: #21262d;
          border: 1px solid #30363d;
          color: #c9d1d9;
          padding: 6px 12px;
          border-radius: 6px;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
          font-size: 12px;
          cursor: pointer;
          transition: background 0.15s;
        }
        .es-btn:hover { background: #30363d; }
        .es-btn.active { background: #1f6feb; border-color: #1f6feb; }
        .es-btn.paused { background: #da3633; border-color: #da3633; }

        .es-list {
          flex: 1;
          overflow: auto;
          padding: 4px 0;
          font-family: 'SF Mono', 'Fira Code', Consolas, monospace;
        }
        .es-list::-webkit-scrollbar { width: 8px; }
        .es-list::-webkit-scrollbar-track { background: #0d1117; }
        .es-list::-webkit-scrollbar-thumb { background: #30363d; border-radius: 4px; }

        .es-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 200px;
          color: #484f58;
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
          border-bottom: 1px solid #21262d;
          cursor: pointer;
          transition: background 0.1s;
          overflow-x: auto;
        }
        .event-row:hover { background: #161b22; }
        .event-time {
          font-size: 11px;
          color: #484f58;
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
        .event-topic.source-agent { background: #1a1932; color: #bc8cff; }
        .event-topic.source-cli { background: #122d20; color: #3fb950; }
        .event-topic.source-signal { background: #2d1f12; color: #d29922; }
        .event-topic.source-echo { background: #1f2330; color: #79c0ff; }
        .event-topic.source-scheduler { background: #2d1229; color: #f778ba; }
        .event-topic.source-logger { background: #1a2332; color: #58a6ff; }
        .event-topic.source-event-viewer { background: #2d2a12; color: #e3b341; }
        .event-topic.source-default { background: #21262d; color: #8b949e; }
        .event-preview {
          font-size: 12px;
          color: #8b949e;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
        }
        .event-detail {
          display: none;
          padding: 0 16px 12px 98px;
          background: #0d1117;
          border-bottom: 1px solid #21262d;
        }
        .event-detail.open { display: block; }
        .event-detail pre {
          background: #161b22;
          border: 1px solid #30363d;
          border-radius: 6px;
          padding: 12px;
          font-size: 12px;
          overflow: auto;
          max-height: 400px;
          color: #c9d1d9;
          line-height: 1.5;
        }
        .event-detail-toolbar {
          display: flex;
          gap: 6px;
          margin-bottom: 6px;
        }
        .detail-btn {
          background: #21262d;
          border: 1px solid #30363d;
          color: #8b949e;
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 11px;
          cursor: pointer;
          font-family: inherit;
        }
        .detail-btn:hover { background: #30363d; color: #c9d1d9; }

        /* Log rows */
        .log-row {
          display: flex;
          align-items: flex-start;
          gap: 12px;
          padding: 4px 16px;
          border-bottom: 1px solid #161b22;
          cursor: pointer;
          transition: background 0.1s;
        }
        .log-row:hover { background: #161b22; }
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
        .log-level.log { background: #21262d; color: #8b949e; }
        .log-level.debug { background: #1a2332; color: #58a6ff; }
        .log-level.info { background: #122d20; color: #3fb950; }
        .log-level.warn { background: #2d1f12; color: #d29922; }
        .log-level.error { background: #2d1215; color: #f85149; }
        .log-message {
          font-size: 12px;
          color: #6e7681;
          flex: 1;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .log-detail {
          display: none;
          padding: 0 16px 12px 98px;
          background: #0d1117;
          border-bottom: 1px solid #161b22;
        }
        .log-detail.open { display: block; }
        .log-detail pre {
          background: #161b22;
          border: 1px solid #30363d;
          border-radius: 6px;
          padding: 12px;
          font-size: 12px;
          overflow: auto;
          max-height: 400px;
          color: #c9d1d9;
          line-height: 1.5;
        }
      `}</style>

<<<<<<< HEAD
      <div class="es-header">
        <div class="es-tabs">
          <button
            class={`es-tab${activeTab === "events" ? " active" : ""}`}
            onClick={() => { setActiveTab("events"); setExpandedId(null); }}
          >
            Events
          </button>
          <button
            class={`es-tab${activeTab === "logs" ? " active" : ""}`}
            onClick={() => { setActiveTab("logs"); setExpandedId(null); }}
          >
            Logs
          </button>
        </div>
        <div class="es-status">
          <span class={dotClass} />
          {statusLabel}
        </div>
        <div class="es-badge">
          {filtered.length} {activeTab === "events" ? "events" : "logs"}
        </div>
      </div>

      <div class="es-toolbar">
        <input
          class="es-filter"
          type="text"
          placeholder={activeTab === "events" ? "Filter by topic (e.g. agent.*)" : "Filter by topic (e.g. debug.*)"}
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        />
        <button class="es-btn" onClick={clearActive}>Clear</button>
        <button
          class={`es-btn${isPaused ? " paused" : ""}`}
          onClick={() => setIsPaused((p) => !p)}
        >
          {isPaused ? "Resume" : "Pause"}
        </button>
        <button
          class={`es-btn${autoScroll ? " active" : ""}`}
          onClick={() => setAutoScroll((a) => !a)}
          title="Toggle auto-scroll"
        >
          Auto-scroll
        </button>
      </div>

      <div class="es-list" ref={listRef} onScroll={handleScroll}>
        {filtered.length === 0 ? (
          <div class="es-empty">
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
=======
      <div class="es-root">
        <div class="es-sticky">
          <div class="es-header">
            <div class="es-header-title">Event Stream</div>
            <div class="es-tabs">
              <button
                class={`es-tab${activeTab === "events" ? " active" : ""}`}
                onClick={() => { setActiveTab("events"); setExpandedId(null); }}
              >
                Events
              </button>
              <button
                class={`es-tab${activeTab === "logs" ? " active" : ""}`}
                onClick={() => { setActiveTab("logs"); setExpandedId(null); }}
              >
                Logs
              </button>
            </div>
            <div class="es-status">
              <span class={dotClass} />
              {statusLabel}
            </div>
            <div class="es-badge">
              {filtered.length} {activeTab === "events" ? "events" : "logs"}
            </div>
          </div>

          <div class="es-toolbar">
            <input
              class="es-filter"
              type="text"
              placeholder={activeTab === "events" ? "Filter by topic (e.g. agent.*)" : "Filter by topic (e.g. debug.*)"}
              value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
            />
            <button class="es-btn" onClick={clearActive}>Clear</button>
            <button
              class={`es-btn${isPaused ? " paused" : ""}`}
              onClick={() => setIsPaused((p) => !p)}
            >
              {isPaused ? "Resume" : "Pause"}
            </button>
            <button
              class={`es-btn${autoScroll ? " active" : ""}`}
              onClick={() => setAutoScroll((a) => !a)}
              title="Toggle auto-scroll"
            >
              Auto-scroll
            </button>
          </div>
        </div>

        <div class="es-list" ref={listRef} onScroll={handleScroll}>
          {filtered.length === 0 ? (
            <div class="es-empty">
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
>>>>>>> origin/main
      </div>
    </>
  );
}
