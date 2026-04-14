import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WebSocketManager } from "../websocket";

// Minimal WebSocket mock — replaces the browser global during tests
class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = 0; // CONNECTING
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3; // CLOSED
    this.onclose?.();
  }

  send(_data: string) {}

  receiveMessage(data: object) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

// Save and restore browser globals so other tests aren't affected
let savedWebSocket: unknown;
let savedLocation: unknown;

beforeEach(() => {
  MockWebSocket.instances = [];
  savedWebSocket = (globalThis as Record<string, unknown>).WebSocket;
  savedLocation = (globalThis as Record<string, unknown>).location;
  (globalThis as Record<string, unknown>).WebSocket = MockWebSocket;
  // Stub location so URL construction uses ws: not wss:
  (globalThis as Record<string, unknown>).location = { protocol: "http:", host: "localhost:3000" };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).WebSocket = savedWebSocket;
  (globalThis as Record<string, unknown>).location = savedLocation;
  MockWebSocket.instances = [];
});

describe("WebSocketManager", () => {
  test("emits 'connecting' status on connect()", () => {
    const manager = new WebSocketManager("/ws");
    const statuses: string[] = [];
    manager.onStatus((s) => statuses.push(s));

    manager.connect();

    expect(statuses).toEqual(["connecting"]);
    manager.destroy();
  });

  test("emits 'connected' when socket opens", () => {
    const manager = new WebSocketManager("/ws");
    const statuses: string[] = [];
    manager.onStatus((s) => statuses.push(s));

    manager.connect();
    MockWebSocket.instances[0].open();

    expect(statuses).toContain("connected");
    manager.destroy();
  });

  test("emits 'disconnected' when socket closes", () => {
    const manager = new WebSocketManager("/ws");
    const statuses: string[] = [];
    manager.onStatus((s) => statuses.push(s));

    manager.connect();
    MockWebSocket.instances[0].open();
    MockWebSocket.instances[0].close();

    expect(statuses).toContain("disconnected");
    manager.destroy();
  });

  test("delivers parsed messages to onMessage handlers", () => {
    const manager = new WebSocketManager("/ws");
    const received: object[] = [];
    manager.onMessage((msg) => received.push(msg));

    manager.connect();
    MockWebSocket.instances[0].receiveMessage({
      topic: "agent.task.completed",
      payload: { result: "ok" },
      timestamp: "2026-04-14T00:00:00Z",
    });

    expect(received).toHaveLength(1);
    expect((received[0] as { topic: string }).topic).toBe("agent.task.completed");
    manager.destroy();
  });

  test("ignores malformed (non-JSON) messages", () => {
    const manager = new WebSocketManager("/ws");
    const received: object[] = [];
    manager.onMessage((msg) => received.push(msg));

    manager.connect();
    // Directly trigger onmessage with bad JSON
    MockWebSocket.instances[0].onmessage?.({ data: "not-json{{" });

    expect(received).toHaveLength(0);
    manager.destroy();
  });

  test("onStatus unsubscribe stops further notifications", () => {
    const manager = new WebSocketManager("/ws");
    const statuses: string[] = [];
    const off = manager.onStatus((s) => statuses.push(s));

    manager.connect(); // emits "connecting"
    off(); // unsubscribe
    MockWebSocket.instances[0].open(); // would emit "connected" but handler is gone

    expect(statuses).toEqual(["connecting"]);
    manager.destroy();
  });

  test("destroy() prevents new connections", () => {
    const manager = new WebSocketManager("/ws");

    manager.connect();
    MockWebSocket.instances[0].open();
    manager.destroy();

    // After destroy, connect() is a no-op — no additional WebSocket created
    manager.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
