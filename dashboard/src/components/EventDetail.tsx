import type { WsMessage } from "../lib/websocket";

interface EventDetailProps {
  msg: WsMessage;
  onClose: () => void;
}

export function EventDetail({ msg, onClose }: EventDetailProps) {
  function copyToClipboard() {
    navigator.clipboard?.writeText(JSON.stringify(msg, null, 2)).catch(() => {});
  }

  return (
    <div class="event-detail open">
      <div class="event-detail-toolbar">
        <button class="detail-btn" onClick={copyToClipboard}>Copy</button>
        <button class="detail-btn" onClick={onClose}>Collapse</button>
      </div>
      <pre>{JSON.stringify(msg, null, 2)}</pre>
    </div>
  );
}
