import type { WsMessage } from "../lib/websocket";

interface LogRowProps {
  msg: WsMessage;
  isExpanded: boolean;
  onClick: () => void;
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

export function LogRow({ msg, isExpanded, onClick }: LogRowProps) {
  const p = msg.payload as Record<string, unknown> | null;
  const level = (typeof p?.level === "string" ? p.level : "log").toLowerCase();
  const message = typeof p?.message === "string" ? p.message : "";

  return (
    <>
      <div class="log-row" onClick={onClick}>
        <span class="event-time">{formatTime(msg.timestamp)}</span>
        <span class={`log-level ${level}`}>{level}</span>
        <span class="log-message">{message}</span>
      </div>
      {isExpanded && (
        <div class="log-detail open">
          <pre>{JSON.stringify(p, null, 2)}</pre>
        </div>
      )}
    </>
  );
}
