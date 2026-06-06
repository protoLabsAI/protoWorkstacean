/**
 * Database migrations for knowledge.db.
 *
 * Runs once at startup against the shared knowledge.db. Each migration is
 * idempotent and guarded by a migrations tracking table so it only runs once.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "../../lib/log.ts";

const log = logger("migrations");

interface Migration {
  id: string;
  description: string;
  run(db: Database): void;
}

const migrations: Migration[] = [
  {
    id: "drop_world_state_snapshots",
    description: "Drop orphan world_state_snapshots table and index (GOAP removal)",
    run(db: Database) {
      db.exec("DROP INDEX IF EXISTS idx_ws_created_at;");
      db.exec("DROP TABLE IF EXISTS world_state_snapshots;");
    },
  },
];

/**
 * Apply any pending migrations to the given database path.
 * Safe to call multiple times — each migration runs at most once.
 */
export function applyMigrations(dbPath: string): void {
  const resolved = resolve(dbPath);

  try {
    const dir = dirname(resolved);
    if (!existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // If the DB file doesn't exist yet, no migrations needed.
        return;
      }
    }

    const db = new Database(resolved);
    db.exec("PRAGMA journal_mode=WAL;");

    // Track which migrations have run
    db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        applied_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
      );
    `);

    const applied = new Set(
      db.query<{ id: string }, []>("SELECT id FROM _migrations").all().map(r => r.id),
    );

    for (const m of migrations) {
      if (applied.has(m.id)) continue;

      log.info(`Applying migration: ${m.description}`);
      try {
        m.run(db);
        db.run("INSERT INTO _migrations (id, description) VALUES (?, ?)", [m.id, m.description]);
        log.info(`Migration ${m.id} applied successfully`);
      } catch (err) {
        log.error(`Migration ${m.id} failed`, { err });
      }
    }

    db.close();
  } catch (err) {
    // If the DB can't be opened (e.g. file locked), log and move on.
    // The app degrades gracefully without migrations.
    log.warn("Could not apply migrations", { err });
  }
}
