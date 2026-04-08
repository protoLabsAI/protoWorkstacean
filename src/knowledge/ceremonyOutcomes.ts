/**
 * CeremonyOutcomesRepository — persists ceremony execution results to knowledge.db.
 *
 * Uses bun:sqlite for persistence. Gracefully degrades when DB is unavailable.
 * Keeps the last 500 outcomes per ceremony to prevent unbounded growth.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CeremonyOutcome } from "../plugins/CeremonyPlugin.types.ts";

const MAX_OUTCOMES_PER_CEREMONY = 500;

export class CeremonyOutcomesRepository {
  private db: Database | null = null;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = resolve(dbPath ?? "data/knowledge.db");
  }

  /** Initialize the database and run schema migration. */
  init(): void {
    try {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      this.db = new Database(this.dbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ceremony_outcomes (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id       TEXT    NOT NULL,
          ceremony_id  TEXT    NOT NULL,
          skill        TEXT    NOT NULL,
          status       TEXT    NOT NULL,
          duration_ms  INTEGER NOT NULL,
          targets      TEXT    NOT NULL,
          started_at   INTEGER NOT NULL,
          completed_at INTEGER NOT NULL,
          result       TEXT,
          error        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_ceremony_outcomes_ceremony_id
          ON ceremony_outcomes(ceremony_id);
        CREATE INDEX IF NOT EXISTS idx_ceremony_outcomes_started_at
          ON ceremony_outcomes(started_at);
      `);

      console.log(`[ceremony-outcomes] DB ready: ${this.dbPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ceremony-outcomes] DB init failed: ${msg}`);
      this.db = null;
    }
  }

  /** Persist a ceremony outcome. Returns true on success. */
  save(outcome: CeremonyOutcome): boolean {
    if (!this.db) {
      console.warn("[ceremony-outcomes] DB unavailable — outcome not persisted:", outcome.runId);
      return false;
    }

    try {
      this.db
        .query(`
          INSERT INTO ceremony_outcomes
            (run_id, ceremony_id, skill, status, duration_ms, targets, started_at, completed_at, result, error)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          outcome.runId,
          outcome.ceremonyId,
          outcome.skill,
          outcome.status,
          outcome.duration,
          JSON.stringify(outcome.targets),
          outcome.startedAt,
          outcome.completedAt,
          outcome.result ?? null,
          outcome.error ?? null,
        );

      // Prune old outcomes for this ceremony
      this.db
        .query(`
          DELETE FROM ceremony_outcomes
          WHERE ceremony_id = ?
            AND id NOT IN (
              SELECT id FROM ceremony_outcomes
              WHERE ceremony_id = ?
              ORDER BY started_at DESC
              LIMIT ?
            )
        `)
        .run(outcome.ceremonyId, outcome.ceremonyId, MAX_OUTCOMES_PER_CEREMONY);

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ceremony-outcomes] Save failed for run ${outcome.runId}: ${msg}`);
      return false;
    }
  }

  /** Retrieve the most recent outcomes for a ceremony (default: 10). */
  getRecent(ceremonyId: string, limit = 10): CeremonyOutcome[] {
    if (!this.db) return [];

    try {
      const rows = this.db
        .query<
          {
            run_id: string;
            ceremony_id: string;
            skill: string;
            status: string;
            duration_ms: number;
            targets: string;
            started_at: number;
            completed_at: number;
            result: string | null;
            error: string | null;
          },
          [string, number]
        >(
          `SELECT run_id, ceremony_id, skill, status, duration_ms, targets, started_at, completed_at, result, error
           FROM ceremony_outcomes
           WHERE ceremony_id = ?
           ORDER BY started_at DESC
           LIMIT ?`,
        )
        .all(ceremonyId, limit);

      return rows.map((r) => ({
        runId: r.run_id,
        ceremonyId: r.ceremony_id,
        skill: r.skill,
        status: r.status as CeremonyOutcome["status"],
        duration: r.duration_ms,
        targets: JSON.parse(r.targets) as string[],
        startedAt: r.started_at,
        completedAt: r.completed_at,
        result: r.result ?? undefined,
        error: r.error ?? undefined,
      }));
    } catch (err) {
      console.error(`[ceremony-outcomes] getRecent failed for ${ceremonyId}:`, err);
      return [];
    }
  }

  /** Retrieve the latest outcome for a ceremony. */
  getLatest(ceremonyId: string): CeremonyOutcome | null {
    const results = this.getRecent(ceremonyId, 1);
    return results[0] ?? null;
  }

  /** Close the database connection. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
