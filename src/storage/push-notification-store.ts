/**
 * SqlitePushNotificationStore — durable backing for the A2A SDK's
 * `PushNotificationStore` contract. Replaces the SDK's
 * `InMemoryPushNotificationStore` so push-notification configs survive
 * container restarts (multiple times per day on `:dev` via watchtower
 * auto-pulls).
 *
 * Implements the SDK's interface verbatim:
 *   save(taskId, config)
 *   load(taskId) → PushNotificationConfig[]
 *   delete(taskId, configId?)
 *
 * Persistence shape:
 *   - One SQLite database at `${dataDir}/push-notifications.db` (WAL).
 *   - `(task_id, config_id)` is the primary key; SDK supports multiple
 *     configs per task via `config.id`. Configs without an id key on the
 *     literal "" so the contract still holds.
 *   - Every row carries `expires_at`. The store filters out expired rows
 *     on `load()` AND opportunistically GCs on `save()` to keep the table
 *     bounded. Default TTL of 24h captures the realistic lifetime of a
 *     long-running A2A task — operators can override via constructor.
 *   - On init, the store opens the db, runs the schema migration, and
 *     immediately purges anything past its TTL so a cold start doesn't
 *     surface stale configs.
 *
 * Failure modes:
 *   - DB open failure (read-only mount, permissions, etc.) — logged
 *     loudly; subsequent calls become no-ops returning empty arrays.
 *     Service degrades to behaving like an in-memory store with zero
 *     entries (i.e. no push notifications fire) rather than crashing
 *     the A2A endpoint.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PushNotificationConfig } from "@a2a-js/sdk";
import type { PushNotificationStore } from "@a2a-js/sdk/server";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

interface Row {
  task_id: string;
  config_id: string;
  config_json: string;
  created_at: number;
  expires_at: number | null;
}

export class SqlitePushNotificationStore implements PushNotificationStore {
  private db: Database | null = null;
  private readonly dbPath: string;
  private readonly ttlMs: number;

  constructor(dbPath: string, options: { ttlMs?: number } = {}) {
    this.dbPath = resolve(dbPath);
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this._init();
  }

  private _init(): void {
    try {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.db = new Database(this.dbPath);
      this.db.exec("PRAGMA journal_mode=WAL;");
      this.db.exec("PRAGMA synchronous=NORMAL;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS push_notifications (
          task_id     TEXT NOT NULL,
          config_id   TEXT NOT NULL,
          config_json TEXT NOT NULL,
          created_at  INTEGER NOT NULL,
          expires_at  INTEGER,
          PRIMARY KEY (task_id, config_id)
        );
        CREATE INDEX IF NOT EXISTS idx_push_expires
          ON push_notifications(expires_at);
      `);
      // Cold-start purge — a process that's been off for days shouldn't
      // surface stale configs on its first load() call.
      this._purgeExpired();
      console.log(`[push-store] Ready at ${this.dbPath} (ttl=${this.ttlMs}ms)`);
    } catch (err) {
      console.error("[push-store] Init failed — push-notification persistence disabled:", err);
      this.db = null;
    }
  }

  async save(taskId: string, config: PushNotificationConfig): Promise<void> {
    if (!this.db) return;
    const configId = config.id ?? "";
    const now = Date.now();
    const expiresAt = this.ttlMs > 0 ? now + this.ttlMs : null;
    try {
      this.db.run(
        `INSERT INTO push_notifications (task_id, config_id, config_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id, config_id) DO UPDATE SET
           config_json = excluded.config_json,
           created_at  = excluded.created_at,
           expires_at  = excluded.expires_at`,
        [taskId, configId, JSON.stringify(config), now, expiresAt],
      );
      // Opportunistic GC — pass the captured `now` so the row we just
      // inserted (expires_at = now + ttlMs) cannot be purged in the same
      // call when ttlMs is small enough that Date.now() advances past it
      // between INSERT and DELETE.
      this._purgeExpired(now);
    } catch (err) {
      console.error(`[push-store] save() failed for task ${taskId.slice(0, 8)}…:`, err);
    }
  }

  async load(taskId: string): Promise<PushNotificationConfig[]> {
    if (!this.db) return [];
    try {
      const now = Date.now();
      const rows = this.db
        .query<Row, [string, number]>(
          `SELECT task_id, config_id, config_json, created_at, expires_at
             FROM push_notifications
            WHERE task_id = ?
              AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .all(taskId, now);
      return rows.map(r => JSON.parse(r.config_json) as PushNotificationConfig);
    } catch (err) {
      console.error(`[push-store] load() failed for task ${taskId.slice(0, 8)}…:`, err);
      return [];
    }
  }

  async delete(taskId: string, configId?: string): Promise<void> {
    if (!this.db) return;
    try {
      if (configId !== undefined) {
        this.db.run(
          `DELETE FROM push_notifications WHERE task_id = ? AND config_id = ?`,
          [taskId, configId],
        );
      } else {
        this.db.run(`DELETE FROM push_notifications WHERE task_id = ?`, [taskId]);
      }
    } catch (err) {
      console.error(`[push-store] delete() failed for task ${taskId.slice(0, 8)}…:`, err);
    }
  }

  /** Diagnostic: how many configs are currently stored across all tasks. Used in tests. */
  size(): number {
    if (!this.db) return 0;
    try {
      const row = this.db
        .query<{ n: number }, []>(`SELECT COUNT(*) as n FROM push_notifications`)
        .get();
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /** Close the underlying DB handle. Tests + graceful shutdown. */
  close(): void {
    try { this.db?.close(); } catch { /* ignore */ }
    this.db = null;
  }

  private _purgeExpired(cutoff: number = Date.now()): void {
    if (!this.db) return;
    try {
      this.db.run(
        `DELETE FROM push_notifications WHERE expires_at IS NOT NULL AND expires_at <= ?`,
        [cutoff],
      );
    } catch {
      // GC failure is non-fatal — table just gets a bit bigger.
    }
  }
}
