import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { InMemoryEventBus } from "../../bus.ts";
import { LoggerPlugin, redactSecrets } from "../logger.ts";

const pragma = (db: Database, name: string): number =>
  Number(Object.values(db.query(`PRAGMA ${name}`).get() as object)[0]);

describe("redactSecrets (#801)", () => {
  test("masks secret-keyed fields, keeps everything else", () => {
    const out = redactSecrets({
      content: "hello world",
      apiKey: "sk-123",
      meta: { authorization: "Bearer xyz", refresh_token: "r1", note: "ok" },
      QUINN_APP_PRIVATE_KEY: "-----BEGIN-----",
      nested: [{ password: "p", keep: 1 }],
    }) as Record<string, unknown>;
    expect(out.content).toBe("hello world");
    expect(out.apiKey).toBe("[redacted]");
    expect((out.meta as Record<string, unknown>).authorization).toBe("[redacted]");
    expect((out.meta as Record<string, unknown>).refresh_token).toBe("[redacted]");
    expect((out.meta as Record<string, unknown>).note).toBe("ok");
    expect(out.QUINN_APP_PRIVATE_KEY).toBe("[redacted]");
    expect(((out.nested as unknown[])[0] as Record<string, unknown>).password).toBe("[redacted]");
    expect(((out.nested as unknown[])[0] as Record<string, unknown>).keep).toBe(1);
  });
  test("leaves empty/absent secret values + handles cycles", () => {
    const cyc: Record<string, unknown> = { token: "" };
    cyc.self = cyc;
    const out = redactSecrets(cyc) as Record<string, unknown>;
    expect(out.token).toBe(""); // empty not masked
    expect(out.self).toBe("[circular]");
  });
});

describe("LoggerPlugin retention + redaction at rest", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("persists redacted payloads and purges old events on sweep", () => {
    dir = mkdtempSync(join(tmpdir(), "logger-"));
    const bus = new InMemoryEventBus();
    const plugin = new LoggerPlugin(dir);
    plugin.install(bus);

    bus.publish("agent.skill.request", {
      id: "m1", correlationId: "c1", topic: "agent.skill.request", timestamp: Date.now(),
      payload: { content: "do it", apiKey: "sekret" },
    });

    const db = (plugin as unknown as { db: import("bun:sqlite").Database }).db;
    const row = db.query("SELECT payload FROM events WHERE id='m1'").get() as { payload: string };
    expect(row.payload).toContain("do it");
    expect(row.payload).not.toContain("sekret");
    expect(row.payload).toContain("[redacted]");

    // Backdate it past the retention window, then sweep.
    db.run("UPDATE events SET timestamp = ? WHERE id='m1'", [Date.now() - 30 * 86400000]);
    (plugin as unknown as { _sweepRetention: () => void })._sweepRetention();
    expect(db.query("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 0 });

    plugin.uninstall();
  });
});

describe("LoggerPlugin events.db compaction (the 42 GB bug)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("migrates a legacy auto_vacuum=NONE db to INCREMENTAL + reclaims free pages on install", () => {
    dir = mkdtempSync(join(tmpdir(), "logger-vac-"));
    const path = join(dir, "events.db");

    // Simulate the legacy state that grew to 42 GB: auto_vacuum=NONE (sqlite's
    // default) with free pages left by deletes that NONE can't reclaim.
    const seed = new Database(path);
    seed.exec("PRAGMA auto_vacuum=NONE;");
    seed.exec("CREATE TABLE junk (x TEXT)");
    const ins = seed.prepare("INSERT INTO junk VALUES (?)");
    seed.transaction(() => { for (let i = 0; i < 2000; i++) ins.run("x".repeat(400)); })();
    seed.exec("DROP TABLE junk"); // → free pages the NONE db won't return
    expect(pragma(seed, "auto_vacuum")).toBe(0);
    expect(pragma(seed, "freelist_count")).toBeGreaterThan(0);
    seed.close();

    const plugin = new LoggerPlugin(dir);
    plugin.install(new InMemoryEventBus()); // runs the one-time VACUUM migration
    plugin.uninstall();

    const check = new Database(path, { readonly: true });
    expect(pragma(check, "auto_vacuum")).toBe(2); // INCREMENTAL — now incremental_vacuum works
    expect(pragma(check, "freelist_count")).toBe(0); // free pages reclaimed
    check.close();
  });
});
