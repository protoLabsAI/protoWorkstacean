// LogStreamRenderer — renders a live event log stream for a log-stream WidgetDescriptor.
//
// Fetches initial events from the widget's query URL, then subscribes to the
// WebSocket path in props.wsPath for real-time updates.

import { useState, useEffect, useRef } from "preact/hooks";
import { WebSocketManager } from "../../lib/websocket";
import type { WsMessage } from "../../lib/websocket";
import { EventRow } from "../EventRow";

export interface LogStreamWidgetDescriptor {
  id: string;
  title: string;
  type: "log-stream";
  query: string;
  props?: {
    wsPath?: string;
    limit?: number;
  };
}

interface Props {
  descriptor: LogStreamWidgetDescriptor;
}

export function LogStreamRenderer({ descriptor }: Props) {
  const [events, setEvents] = useState<WsMessage[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const queryUrl = descriptor.query;
  const wsPath = descriptor.props?.wsPath;
  const limit = descriptor.props?.limit ?? 100;

  // Load history on mount
  useEffect(() => {
    fetch(`${queryUrl}?limit=${limit}`)
      .then((r) => r.json())
      .then((data: unknown) => {
        const msgs = (Array.isArray(data) ? data : []) as WsMessage[];
        setEvents(msgs.reverse());
      })
      .catch(() => {});
  }, [queryUrl, limit]);

  // WebSocket for live updates
  useEffect(() => {
    if (!wsPath) return;
    const manager = new WebSocketManager(wsPath);
    const off = manager.onMessage((msg) => {
      setEvents((prev) => [...prev, msg]);
    });
    manager.connect();
    return () => {
      off();
      manager.destroy();
    };
  }, [wsPath]);

  // Auto-scroll to bottom
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  function toggleExpanded(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "400px" }}>
      <div
        ref={listRef}
        style={{ flex: 1, overflow: "auto", fontFamily: "'SF Mono', 'Fira Code', Consolas, monospace" }}
      >
        {events.length === 0 ? (
          <div style={{ padding: "16px", color: "#484f58", fontSize: "13px" }}>
            Waiting for events…
          </div>
        ) : (
          events.map((msg) => (
            <EventRow
              key={msg.id ?? msg.timestamp}
              msg={msg}
              isExpanded={expandedId === (msg.id ?? msg.timestamp)}
              onClick={() => toggleExpanded(msg.id ?? msg.timestamp)}
            />
          ))
        )}
      </div>
    </div>
  );
}
