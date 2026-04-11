/**
 * TelemetryService — per-goal and per-action event counters, persisted to knowledge.db.
 *
 * Closes the "is this action actually used?" audit gap:
 *   - Every loaded goal/action is registered at zero on startup, so "never
 *     triggered" shows up in the audit view even after fresh deploys.
 *   - Every evaluation / dispatch / outcome bumps a counter with first_at
 *     and last_at timestamps, so you can detect dead code (count == 0) and
 *     quiet code (last_at is old) separately.
 *
 * The underlying table is shared with CeremonyOutcomesRepository and
 * WorldStateEngine (same knowledge.db file, different tables). Bun's sqlite
 * handles concurrent access with WAL mode.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type TelemetryKind = "goal" | "action";

export type GoalEvent = "evaluated" | "satisfied" | "violated";
export type ActionEvent = "dispatched" | "success" | "failure" | "timeout";

export const GOAL_EVENTS: GoalEvent[] = ["evaluated", "satisfied", "violated"];
export const ACTION_EVENTS: ActionEvent[] = ["dispatched", "success", "failure", "timeout"];

export interface CounterRow {
  kind: TelemetryKind;
  id: string;
  event: string;
  count: number;
  first_at: number | null;
  last_at: number | null;
}

/** Aggregated view of all events for a single goal or action. */
export interface EntitySummary {
  id: string;
  counts: Record<string, number>;
  first_at: number | null;
  last_at: number | null;
}

export class TelemetryService {
  private db: Database | null = null;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = resolve(dbPath ?? "data/knowledge.db");
  }

  init(): void {
    try {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) {
        try {
          mkdirSync(dir, { recursive: true });
        } catch (mkErr) {
          console.error("[telemetry] Cannot create data dir — counters disabled:", mkErr);
          this.db = null;
          return;
        }
      }

      this.db = new Database(this.dbPath);
      this.db.exec("PRAGMA journal_mode=WAL;");
      this.db.exec("PRAGMA synchronous=NORMAL;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS telemetry_counters (
          kind     TEXT NOT NULL,
          id       TEXT NOT NULL,
          event    TEXT NOT NULL,
          count    INTEGER NOT NULL DEFAULT 0,
          first_at INTEGER,
          last_at  INTEGER,
          PRIMARY KEY (kind, id, event)
        );
        CREATE INDEX IF NOT EXISTS idx_telemetry_kind_id
          ON telemetry_counters(kind, id);
      `);
      console.log(`[telemetry] Ready at ${this.dbPath}`);
    } catch (err) {
      console.error("[telemetry] Init failed — counters disabled:", err);
      this.db = null;
    }
  }

  /**
   * Increment a counter for (kind, id, event). If the row doesn't exist yet,
   * it's created with count=1 and first_at=now. last_at is always updated.
   */
  bump(kind: TelemetryKind, id: string, event: string): void {
    if (!this.db) return;
    try {
      const now = Date.now();
      this.db.run(
        `INSERT INTO telemetry_counters (kind, id, event, count, first_at, last_at)
         VALUES (?, ?, ?, 1, ?, ?)
         ON CONFLICT(kind, id, event) DO UPDATE SET
           count = count + 1,
           first_at = COALESCE(first_at, ?),
           last_at = ?`,
        [kind, id, event, now, now, now, now],
      );
    } catch (err) {
      // Swallow — telemetry must never break the caller.
      console.warn("[telemetry] bump failed:", err);
    }
  }

  /**
   * Register a set of known (kind, id, event) tuples at zero count. Used at
   * startup so loaded-but-never-used entities show up in audit views.
   * Existing rows are untouched.
   */
  registerKnown(kind: TelemetryKind, id: string, events: readonly string[]): void {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(
        `INSERT INTO telemetry_counters (kind, id, event, count, first_at, last_at)
         VALUES (?, ?, ?, 0, NULL, NULL)
         ON CONFLICT(kind, id, event) DO NOTHING`,
      );
      for (const event of events) {
        stmt.run(kind, id, event);
      }
    } catch (err) {
      console.warn("[telemetry] registerKnown failed:", err);
    }
  }

  /** Raw counter rows, optionally filtered by kind. */
  snapshot(kind?: TelemetryKind): CounterRow[] {
    if (!this.db) return [];
    try {
      if (kind) {
        return this.db
          .query<CounterRow, [TelemetryKind]>(
            `SELECT kind, id, event, count, first_at, last_at
             FROM telemetry_counters
             WHERE kind = ?
             ORDER BY id, event`,
          )
          .all(kind);
      }
      return this.db
        .query<CounterRow, []>(
          `SELECT kind, id, event, count, first_at, last_at
           FROM telemetry_counters
           ORDER BY kind, id, event`,
        )
        .all();
    } catch (err) {
      console.warn("[telemetry] snapshot failed:", err);
      return [];
    }
  }

  /**
   * Aggregated per-entity view suitable for the dashboard / API. For each
   * distinct (kind, id), collapses all event rows into a single record with
   * event counts as fields and the min first_at / max last_at across events.
   */
  aggregate(kind: TelemetryKind): EntitySummary[] {
    const rows = this.snapshot(kind);
    const byId = new Map<string, EntitySummary>();
    for (const r of rows) {
      let rec = byId.get(r.id);
      if (!rec) {
        rec = { id: r.id, counts: {}, first_at: null, last_at: null };
        byId.set(r.id, rec);
      }
      rec.counts[r.event] = r.count;
      if (r.first_at != null && (rec.first_at == null || r.first_at < rec.first_at)) {
        rec.first_at = r.first_at;
      }
      if (r.last_at != null && (rec.last_at == null || r.last_at > rec.last_at)) {
        rec.last_at = r.last_at;
      }
    }
    return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Entities loaded but never observed in the given window. Used by the
   * dead-code audit: anything that has zero dispatches/evaluations AND
   * whose first_at is older than (now - maxQuietMs) is flagged.
   *
   * Entities with first_at == null (never fired at all) are always included
   * regardless of the window.
   */
  unused(kind: TelemetryKind, maxQuietMs = 72 * 60 * 60 * 1000): EntitySummary[] {
    const primaryEvent: Record<TelemetryKind, string> = {
      goal: "evaluated",
      action: "dispatched",
    };
    const cutoff = Date.now() - maxQuietMs;
    return this.aggregate(kind).filter((e) => {
      const primary = e.counts[primaryEvent[kind]] ?? 0;
      if (primary === 0) return true;
      return (e.last_at ?? 0) < cutoff;
    });
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.db = null;
  }
}
