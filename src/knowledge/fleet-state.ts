/**
 * FleetStateRepository — durable backing for fleet outcome records (ADR-0004 P5).
 *
 * AgentFleetHealthPlugin keeps a 24h rolling window of agent outcomes in memory
 * for health-weighted dispatch and alerts. That window evaporates on restart —
 * every redeploy blinded the fleet view until traffic refilled it. This repo
 * persists each outcome to knowledge.db and rehydrates the window on startup, so
 * health survives restarts.
 *
 * Follows the CeremonyOutcomesRepository / TelemetryService pattern: WAL mode,
 * transactional writes, per-agent pruning to bound growth, and graceful
 * degradation to a no-op when the DB can't be opened (the in-memory path is
 * unchanged — durability is purely additive).
 *
 * Write path: fire-and-forget persist after the in-memory update.
 * Read path: hydrate the most recent N hours into the in-memory window on boot.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Keep at most this many records per system-actor; older rows are pruned on write. */
const MAX_PER_AGENT = 500;

export interface OutcomeRecord {
  systemActor: string;
  skill: string;
  success: boolean;
  durationMs: number;
  costUsd: number;
  correlationId: string;
  failureReason?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  timestamp: number; // Unix ms
}

export class FleetStateRepository {
  private db: Database | null = null;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = resolve(dbPath ?? "data/knowledge.db");
  }

  /** Open the database and ensure the schema exists. Degrades to a no-op on failure. */
  init(): void {
    try {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      this.db = new Database(this.dbPath);
      this.db.exec("PRAGMA journal_mode=WAL;");
      this.db.exec("PRAGMA synchronous=NORMAL;");

      this.db.exec(`
        CREATE TABLE IF NOT EXISTS fleet_outcome_records (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          system_actor    TEXT    NOT NULL,
          skill           TEXT    NOT NULL,
          success         INTEGER NOT NULL,
          duration_ms     INTEGER NOT NULL,
          cost_usd        REAL    NOT NULL DEFAULT 0,
          correlation_id  TEXT    NOT NULL,
          failure_reason  TEXT,
          model           TEXT,
          input_tokens    INTEGER,
          output_tokens   INTEGER,
          timestamp       INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fleet_outcome_actor_ts
          ON fleet_outcome_records(system_actor, timestamp);
        CREATE INDEX IF NOT EXISTS idx_fleet_outcome_skill
          ON fleet_outcome_records(skill, timestamp);
      `);

      console.log(`[fleet-state] DB ready: ${this.dbPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[fleet-state] DB init failed, running in-memory only: ${msg}`);
      this.db = null;
    }
  }

  /** Persist one outcome and prune the actor's history to MAX_PER_AGENT. Returns true on success. */
  recordOutcome(record: OutcomeRecord): boolean {
    if (!this.db) return false;

    try {
      const tx = this.db.transaction(() => {
        this.db!
          .query(`
            INSERT INTO fleet_outcome_records
              (system_actor, skill, success, duration_ms, cost_usd, correlation_id,
               failure_reason, model, input_tokens, output_tokens, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            record.systemActor,
            record.skill,
            record.success ? 1 : 0,
            record.durationMs,
            record.costUsd,
            record.correlationId,
            record.failureReason ?? null,
            record.model ?? null,
            record.inputTokens ?? null,
            record.outputTokens ?? null,
            record.timestamp,
          );

        this.db!
          .query(`
            DELETE FROM fleet_outcome_records
            WHERE system_actor = ?
              AND id NOT IN (
                SELECT id FROM fleet_outcome_records
                WHERE system_actor = ?
                ORDER BY timestamp DESC
                LIMIT ?
              )
          `)
          .run(record.systemActor, record.systemActor, MAX_PER_AGENT);
      });

      tx();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[fleet-state] recordOutcome failed: ${msg}`);
      return false;
    }
  }

  /** Return outcome records from the last `hoursBack` hours, oldest first (for window hydration). */
  hydrateRecords(hoursBack = 24): OutcomeRecord[] {
    if (!this.db) return [];

    try {
      const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
      const rows = this.db
        .query<{
          system_actor: string;
          skill: string;
          success: number;
          duration_ms: number;
          cost_usd: number;
          correlation_id: string;
          failure_reason: string | null;
          model: string | null;
          input_tokens: number | null;
          output_tokens: number | null;
          timestamp: number;
        }, [number]>(`
          SELECT * FROM fleet_outcome_records
          WHERE timestamp >= ?
          ORDER BY timestamp ASC
        `)
        .all(cutoff);

      return rows.map((r) => ({
        systemActor: r.system_actor,
        skill: r.skill,
        success: r.success === 1,
        durationMs: r.duration_ms,
        costUsd: r.cost_usd,
        correlationId: r.correlation_id,
        failureReason: r.failure_reason ?? undefined,
        model: r.model ?? undefined,
        inputTokens: r.input_tokens ?? undefined,
        outputTokens: r.output_tokens ?? undefined,
        timestamp: r.timestamp,
      }));
    } catch (err) {
      console.error("[fleet-state] hydrateRecords failed:", err);
      return [];
    }
  }

  /** Close the database connection. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
