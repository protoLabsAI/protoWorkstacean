// WebSocket manager with exponential backoff reconnection

export type WsMessage = {
  id?: string;
  topic: string;
  payload: unknown;
  timestamp: string;
  source?: string;
};

type MessageHandler = (msg: WsMessage) => void;
type StatusHandler = (status: "connecting" | "connected" | "disconnected") => void;

const MAX_RETRIES = 10;
const INITIAL_DELAY = 1000;
const MAX_DELAY = 15000;

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private retryCount = 0;
  private retryDelay = INITIAL_DELAY;
  private destroyed = false;
  private messageHandlers: Set<MessageHandler> = new Set();
  private statusHandlers: Set<StatusHandler> = new Set();
  private url: string;

  constructor(path: string) {
    const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
    const host = typeof location !== "undefined" ? location.host : "localhost";
    this.url = `${proto}//${host}${path}`;
  }

  connect() {
    if (this.destroyed) return;
    this.emit("connecting");

    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.retryCount = 0;
      this.retryDelay = INITIAL_DELAY;
      this.emit("connected");
    };

    this.ws.onmessage = (evt: MessageEvent) => {
      try {
        const msg = JSON.parse(evt.data as string) as WsMessage;
        for (const handler of this.messageHandlers) {
          handler(msg);
        }
      } catch {
        // ignore malformed messages
      }
    };

    this.ws.onclose = () => {
      if (!this.destroyed) {
        this.emit("disconnected");
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private scheduleReconnect() {
    if (this.destroyed || this.retryCount >= MAX_RETRIES) return;
    // exponential backoff with jitter
    const jitter = Math.random() * 500;
    const backoff = Math.min(this.retryDelay + jitter, MAX_DELAY);
    this.retryCount++;
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_DELAY);
    setTimeout(() => this.reconnect(), backoff);
  }

  private reconnect() {
    if (this.destroyed) return;
    this.ws = null;
    this.connect();
  }

  private emit(status: "connecting" | "connected" | "disconnected") {
    for (const handler of this.statusHandlers) {
      handler(status);
    }
  }

  onMessage(handler: MessageHandler) {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: StatusHandler) {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  destroy() {
    this.destroyed = true;
    this.ws?.close();
    this.ws = null;
    this.messageHandlers.clear();
    this.statusHandlers.clear();
  }
}
