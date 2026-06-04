/**
 * Minimal SQLite migration runner keyed on `PRAGMA user_version`.
 *
 * Every store used `CREATE TABLE IF NOT EXISTS` against a persistent prod volume
 * with no versioning — so any non-additive schema change silently no-ops on an
 * existing DB (the `IF NOT EXISTS` skips it) and drifts at query time. This gives
 * each store an ordered, version-stamped migration list applied deterministically
 * at init.
 *
 * Baselining: a store's current schema becomes migration **v1** (its body is the
 * existing `CREATE TABLE IF NOT EXISTS …`, still idempotent). On an existing prod
 * DB (user_version=0, tables already present) v1 is a no-op that just stamps the
 * version; on a fresh DB it creates the tables. Future changes add v2, v3, … with
 * `ALTER TABLE` etc. Each migration runs in a transaction; the version is bumped
 * only after its `up` succeeds.
 */

import type { Database } from "bun:sqlite";

export interface Migration {
  /** Monotonic, 1-based. Applied in ascending order; only those > current run. */
  version: number;
  up: (db: Database) => void;
}

/** Current `user_version` (0 on a fresh/unstamped DB). */
export function schemaVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version?: number } | null;
  return row?.user_version ?? 0;
}

/**
 * Apply every migration whose version is greater than the DB's current
 * `user_version`, in ascending order, each in its own transaction. Returns the
 * resulting version. Throws (fail-loud) if a migration's `up` throws — the
 * version is NOT advanced past a failed step.
 */
export function runMigrations(db: Database, migrations: Migration[]): number {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  let current = schemaVersion(db);
  for (const m of ordered) {
    if (m.version <= current) continue;
    db.transaction(() => {
      m.up(db);
      // PRAGMA can't be parameterized; version is an integer from our own list.
      db.exec(`PRAGMA user_version = ${Math.trunc(m.version)};`);
    })();
    current = m.version;
  }
  return current;
}
