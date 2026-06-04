import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations, schemaVersion } from "../sqlite-migrate.ts";

const fresh = () => new Database(":memory:");

describe("runMigrations", () => {
  test("applies migrations in order and stamps user_version", () => {
    const db = fresh();
    const v = runMigrations(db, [
      { version: 1, up: (d) => d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)") },
      { version: 2, up: (d) => d.exec("ALTER TABLE t ADD COLUMN name TEXT") },
    ]);
    expect(v).toBe(2);
    expect(schemaVersion(db)).toBe(2);
    db.exec("INSERT INTO t (id, name) VALUES (1, 'x')"); // both migrations applied
    db.close();
  });

  test("only runs migrations newer than the current version (idempotent re-run)", () => {
    const db = fresh();
    let ranV2 = 0;
    const migs = [
      { version: 1, up: (d: Database) => d.exec("CREATE TABLE t (id INTEGER)") },
      { version: 2, up: (d: Database) => { ranV2++; d.exec("ALTER TABLE t ADD COLUMN name TEXT"); } },
    ];
    runMigrations(db, migs);
    runMigrations(db, migs); // second run is a no-op
    expect(ranV2).toBe(1);
    expect(schemaVersion(db)).toBe(2);
    db.close();
  });

  test("baseline v1 is a no-op on an existing (already-created) DB and just stamps the version", () => {
    const db = fresh();
    db.exec("CREATE TABLE t (id INTEGER)"); // simulate an existing prod table, user_version=0
    expect(schemaVersion(db)).toBe(0);
    const v1 = { version: 1, up: (d: Database) => d.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER)") };
    expect(runMigrations(db, [v1])).toBe(1);
    expect(schemaVersion(db)).toBe(1);
    db.close();
  });

  test("a throwing migration fails loud and does NOT advance the version", () => {
    const db = fresh();
    runMigrations(db, [{ version: 1, up: (d) => d.exec("CREATE TABLE t (id INTEGER)") }]);
    expect(() => runMigrations(db, [{ version: 2, up: () => { throw new Error("boom"); } }])).toThrow("boom");
    expect(schemaVersion(db)).toBe(1);
    db.close();
  });
});
