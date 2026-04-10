import type { WsMessage } from "../lib/websocket";

interface EventRowProps {
  msg: WsMessage;
  isExpanded: boolean;
  onClick: () => void;
}

function getSource(topic: string): string {
  if (!topic) return "default";
  return topic.split(".")[0].toLowerCase();
}

function compressTopic(topic: string): string {
  if (!topic) return "";
  return topic.split(".").map((p) => p[0]).join(".");
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

function formatPayload(msg: WsMessage): string {
  if (typeof msg.payload === "string") return msg.payload;
  const p = msg.payload as Record<string, unknown> | null;
  if (p && typeof p.content === "string") return p.content;
  return JSON.stringify(msg.payload);
}

export function EventRow({ msg, isExpanded, onClick }: EventRowProps) {
  const source = getSource(msg.topic);

  return (
    <>
      <div class="event-row" onClick={onClick}>
        <span class="event-time">{formatTime(msg.timestamp)}</span>
        <span class={`event-topic source-${source}`} title={msg.topic}>
          {compressTopic(msg.topic)}
        </span>
        <span class="event-preview">{formatPayload(msg)}</span>
      </div>
      {isExpanded && (
        <div class="event-detail open">
          <pre>{JSON.stringify(msg, null, 2)}</pre>
        </div>
      )}
    </>
  );
}
