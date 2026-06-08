/**
 * FlowStore — durable home for `flow.item.*` dispatch records (bun:sqlite).
 *
 * The dispatcher publishes `flow.item.{created,updated,completed}` for every
 * skill dispatch (one item per correlationId, id = `skill-<correlationId>`).
 * Today they only live in the BusHistoryRecorder's in-memory ring (30-min TTL)
 * — so the dashboard can't browse or replay execution history across a
 * restart. The orchestration canvas (ADR-0008 P1) needs a durable, queryable
 * execution log: this store backs `GET /api/flows`.
 *
 * One row per flow item, upserted across its lifecycle (created → updated* →
 * completed) with COALESCE so a partial update never nulls a field a prior
 * event set. Bounded by retention (`prune`) with `auto_vacuum=INCREMENTAL` —
 * heed the events.db lesson: an unbounded sqlite log on the data volume grows
 * forever. Degrades to a no-op when the DB is unavailable, like the other
 * sqlite-backed stores.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "../../lib/log.ts";
import type { FlowItemPayload } from "../event-bus/payloads.ts";

const log = logger("flow-store");

export interface FlowRecord {
  id: string;
  type: string | null;
  status: string | null;
  stage: string | null;
  createdAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  skill: string | null;
  executorType: string | null;
  targetAgent: string | null;
  errorPreview: string | null;
  updatedAt: number;
}

interface Row {
  id: string;
  type: string | null;
  status: string | null;
  stage: string | null;
  created_at: number | null;
  started_at: number | null;
  completed_at: number | null;
  duration_ms: number | null;
  skill: string | null;
  executor_type: string | null;
  target_agent: string | null;
  error_preview: string | null;
  updated_at: number;
}

function s(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function n(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export interface FlowQuery {
  /** Only items created at/after this epoch-ms. */
  sinceMs?: number;
  /** Filter by status (active / completed / failed …). */
  status?: string;
  /** Max rows (default 200, capped 1000). */
  limit?: number;
}

export class FlowStore {
  private db: Database | null = null;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = resolve(dbPath);
    this._init();
  }

  private _init(): void {
    try {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.db = new Database(this.dbPath);
      this.db.exec("PRAGMA journal_mode=WAL;");
      this.db.exec("PRAGMA synchronous=NORMAL;");
      this.db.exec("PRAGMA busy_timeout=5000;");
      this.db.exec("PRAGMA auto_vacuum=INCREMENTAL;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS flow_items (
          id            TEXT PRIMARY KEY,
          type          TEXT,
          status        TEXT,
          stage         TEXT,
          created_at    INTEGER,
          started_at    INTEGER,
          completed_at  INTEGER,
          duration_ms   INTEGER,
          skill         TEXT,
          executor_type TEXT,
          target_agent  TEXT,
          error_preview TEXT,
          updated_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_flow_created ON flow_items(created_at);
        CREATE INDEX IF NOT EXISTS idx_flow_status  ON flow_items(status);
      `);
      log.info(`Ready at ${this.dbPath}`);
    } catch (err) {
      log.error("Init failed — flow persistence disabled", { err });
      this.db = null;
    }
  }

  /** Upsert a flow item from a `flow.item.*` event payload (merge across lifecycle). */
  upsert(item: FlowItemPayload): void {
    if (!this.db || !item?.id) return;
    const meta = (item.meta ?? {}) as Record<string, unknown>;
    // duration is computed at read-time (toRecord) from started_at + completed_at,
    // which arrive in *different* events — so only persist a meta-provided value.
    const durationMs = n(meta.durationMs);
    try {
      this.db.run(
        `INSERT INTO flow_items
           (id, type, status, stage, created_at, started_at, completed_at, duration_ms,
            skill, executor_type, target_agent, error_preview, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type          = COALESCE(excluded.type, type),
           status        = COALESCE(excluded.status, status),
           stage         = COALESCE(excluded.stage, stage),
           created_at    = COALESCE(created_at, excluded.created_at),
           started_at    = COALESCE(started_at, excluded.started_at),
           completed_at  = COALESCE(excluded.completed_at, completed_at),
           duration_ms   = COALESCE(excluded.duration_ms, duration_ms),
           skill         = COALESCE(excluded.skill, skill),
           executor_type = COALESCE(excluded.executor_type, executor_type),
           target_agent  = COALESCE(excluded.target_agent, target_agent),
           error_preview = COALESCE(excluded.error_preview, error_preview),
           updated_at    = excluded.updated_at`,
        [
          item.id,
          s(item.type),
          s(item.status),
          s(item.stage),
          n(item.createdAt),
          n(item.startedAt),
          n(item.completedAt),
          durationMs,
          s(meta.skill),
          s(meta.executorType),
          s(meta.targetAgent),
          (s(meta.error) ?? s(meta.errorMessage))?.slice(0, 500) ?? null,
          Date.now(),
        ],
      );
    } catch (err) {
      log.error(`upsert "${item.id}" failed`, { err });
    }
  }

  /** Recent flow items, newest first. */
  recent(q: FlowQuery = {}): FlowRecord[] {
    if (!this.db) return [];
    const limit = Math.min(Math.max(1, q.limit ?? 200), 1000);
    const clauses: string[] = [];
    const params: (number | string)[] = [];
    if (q.sinceMs !== undefined) { clauses.push("created_at >= ?"); params.push(q.sinceMs); }
    if (q.status) { clauses.push("status = ?"); params.push(q.status); }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    try {
      const rows = this.db
        .query(`SELECT * FROM flow_items ${where} ORDER BY COALESCE(created_at, updated_at) DESC LIMIT ?`)
        .all(...params, limit) as Row[];
      return rows.map(toRecord);
    } catch (err) {
      log.error("recent() failed", { err });
      return [];
    }
  }

  /** One flow item by id (`skill-<correlationId>`), or null. */
  get(id: string): FlowRecord | null {
    if (!this.db) return null;
    try {
      const row = this.db.query("SELECT * FROM flow_items WHERE id = ?").get(id) as Row | undefined;
      return row ? toRecord(row) : null;
    } catch (err) {
      log.error(`get("${id}") failed`, { err });
      return null;
    }
  }

  /** Delete items created before `beforeMs`. Returns rows removed. */
  prune(beforeMs: number): number {
    if (!this.db) return 0;
    try {
      const before = this.count();
      this.db.run("DELETE FROM flow_items WHERE COALESCE(created_at, updated_at) < ?", [beforeMs]);
      const removed = before - this.count();
      if (removed > 0) {
        this.db.exec("PRAGMA incremental_vacuum;");
        log.info(`pruned ${removed} flow item(s) older than ${new Date(beforeMs).toISOString()}`);
      }
      return removed;
    } catch (err) {
      log.error("prune() failed", { err });
      return 0;
    }
  }

  count(): number {
    if (!this.db) return 0;
    try {
      return (this.db.query("SELECT COUNT(*) AS n FROM flow_items").get() as { n: number }).n;
    } catch {
      return 0;
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // already closed
    }
    this.db = null;
  }
}

function toRecord(r: Row): FlowRecord {
  return {
    id: r.id,
    type: r.type,
    status: r.status,
    stage: r.stage,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    durationMs:
      r.duration_ms ??
      (r.started_at !== null && r.completed_at !== null ? r.completed_at - r.started_at : null),
    skill: r.skill,
    executorType: r.executor_type,
    targetAgent: r.target_agent,
    errorPreview: r.error_preview,
    updatedAt: r.updated_at,
  };
}
