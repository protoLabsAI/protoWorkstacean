/**
 * SqlitePushNotificationStore tests — exercises the SDK
 * `PushNotificationStore` contract plus the persistence guarantees that
 * justify replacing the in-memory store: cross-restart rehydration, TTL
 * eviction, multi-config-per-task semantics.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PushNotificationConfig } from "@a2a-js/sdk";
import { SqlitePushNotificationStore } from "../push-notification-store.ts";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "push-store-test-"));
  dbPath = join(dir, "push-notifications.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<PushNotificationConfig> = {}): PushNotificationConfig {
  return {
    url: "https://example.com/callback",
    token: "secret-token",
    ...overrides,
  };
}

describe("SqlitePushNotificationStore — contract", () => {
  test("save then load returns the stored config", async () => {
    const store = new SqlitePushNotificationStore(dbPath);
    await store.save("task-1", makeConfig({ url: "https://a.example.com/cb" }));
    const loaded = await store.load("task-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].url).toBe("https://a.example.com/cb");
    expect(loaded[0].token).toBe("secret-token");
    store.close();
  });

  test("multiple configs per task — keyed by config.id", async () => {
    const store = new SqlitePushNotificationStore(dbPath);
    await store.save("task-1", makeConfig({ id: "primary", url: "https://a.example.com/cb" }));
    await store.save("task-1", makeConfig({ id: "fallback", url: "https://b.example.com/cb" }));
    const loaded = await store.load("task-1");
    expect(loaded).toHaveLength(2);
    expect(loaded.map(c => c.url).sort()).toEqual([
      "https://a.example.com/cb",
      "https://b.example.com/cb",
    ]);
    store.close();
  });

  test("save with same (taskId, configId) overwrites the existing row", async () => {
    const store = new SqlitePushNotificationStore(dbPath);
    await store.save("task-1", makeConfig({ id: "primary", url: "https://old.example.com/cb" }));
    await store.save("task-1", makeConfig({ id: "primary", url: "https://new.example.com/cb" }));
    const loaded = await store.load("task-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].url).toBe("https://new.example.com/cb");
    store.close();
  });

  test("load on unknown taskId returns empty array", async () => {
    const store = new SqlitePushNotificationStore(dbPath);
    const loaded = await store.load("never-saved");
    expect(loaded).toEqual([]);
    store.close();
  });

  test("delete with configId removes only that config", async () => {
    const store = new SqlitePushNotificationStore(dbPath);
    await store.save("task-1", makeConfig({ id: "primary", url: "https://a.example.com/cb" }));
    await store.save("task-1", makeConfig({ id: "fallback", url: "https://b.example.com/cb" }));
    await store.delete("task-1", "primary");
    const loaded = await store.load("task-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].url).toBe("https://b.example.com/cb");
    store.close();
  });

  test("delete without configId removes ALL configs for the task", async () => {
    const store = new SqlitePushNotificationStore(dbPath);
    await store.save("task-1", makeConfig({ id: "primary", url: "https://a.example.com/cb" }));
    await store.save("task-1", makeConfig({ id: "fallback", url: "https://b.example.com/cb" }));
    await store.delete("task-1");
    const loaded = await store.load("task-1");
    expect(loaded).toEqual([]);
    store.close();
  });
});

describe("SqlitePushNotificationStore — persistence", () => {
  test("configs survive close + reopen on the same db file (cross-restart)", async () => {
    // First lifecycle — save then close.
    const first = new SqlitePushNotificationStore(dbPath);
    await first.save("task-1", makeConfig({ url: "https://persist.example.com/cb" }));
    first.close();

    // Second lifecycle — reopen the same path; data should still be there.
    const second = new SqlitePushNotificationStore(dbPath);
    const loaded = await second.load("task-1");
    expect(loaded).toHaveLength(1);
    expect(loaded[0].url).toBe("https://persist.example.com/cb");
    second.close();
  });
});

describe("SqlitePushNotificationStore — TTL eviction", () => {
  test("expired configs are filtered from load() even before GC runs", async () => {
    // ttl=1ms means everything expires almost immediately. Wait 5ms to
    // be sure we're past the expiry boundary, then load() should return
    // empty without any explicit purge call.
    const store = new SqlitePushNotificationStore(dbPath, { ttlMs: 1 });
    await store.save("task-1", makeConfig({ url: "https://expired.example.com/cb" }));
    await new Promise(r => setTimeout(r, 5));
    const loaded = await store.load("task-1");
    expect(loaded).toEqual([]);
    store.close();
  });

  test("expired configs are GC'd from the table on the next save() call", async () => {
    const store = new SqlitePushNotificationStore(dbPath, { ttlMs: 1 });
    await store.save("task-old", makeConfig({ url: "https://expired.example.com/cb" }));
    expect(store.size()).toBe(1);
    await new Promise(r => setTimeout(r, 5));
    // Saving a fresh entry triggers opportunistic purge of the old row.
    await store.save("task-new", makeConfig({ url: "https://fresh.example.com/cb" }));
    expect(store.size()).toBe(1); // only the fresh row survived
    store.close();
  });

  test("ttlMs=0 means no expiry", async () => {
    const store = new SqlitePushNotificationStore(dbPath, { ttlMs: 0 });
    await store.save("task-1", makeConfig({ url: "https://forever.example.com/cb" }));
    await new Promise(r => setTimeout(r, 10));
    const loaded = await store.load("task-1");
    expect(loaded).toHaveLength(1);
    store.close();
  });

  test("cold-start purge clears stale rows before they reach load()", async () => {
    const first = new SqlitePushNotificationStore(dbPath, { ttlMs: 1 });
    await first.save("task-stale", makeConfig({ url: "https://stale.example.com/cb" }));
    first.close();
    await new Promise(r => setTimeout(r, 5));

    // Reopen — _init() runs the cold-start purge, so the stale row is
    // gone before the first load().
    const second = new SqlitePushNotificationStore(dbPath, { ttlMs: 1 });
    expect(second.size()).toBe(0);
    second.close();
  });
});

describe("SqlitePushNotificationStore — degraded mode", () => {
  test("when init fails (e.g. unreachable path), all ops become no-ops returning empty", async () => {
    // Path that points into a file (not a directory) — Database open will fail.
    const store = new SqlitePushNotificationStore("/dev/null/cannot-create-here.db");
    await store.save("task-1", makeConfig());
    expect(await store.load("task-1")).toEqual([]);
    await store.delete("task-1");
    expect(store.size()).toBe(0);
    // No throw — degraded silently.
  });
});
