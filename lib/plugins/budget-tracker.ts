/**
 * BudgetTracker — per-agent, per-project, and daily budget tracking
 * backed by SQLite (consistent with LoggerPlugin).
 *
 * Implements:
 *   - budget_tracker: upsert/query logic
 *   - daily_budget enforcement with configurable caps
 *   - Transaction ledger (write-ahead style)
 *
 * Deviation rule: if storage layer is unavailable, fall back to in-memory
 * tracking with WAL; resume persistence on recovery.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  BudgetRecord,
  BudgetState,
  BudgetTierLevel,
} from "../types/budget.ts";
import { MAX_PROJECT_BUDGET, MAX_DAILY_BUDGET } from "../types/budget.ts";

// ── In-memory WAL (write-ahead log) ─────────────────────────────────────────

interface WalEntry {
  type: "record" | "actual";
  data: BudgetRecord;
  queuedAt: number;
}

// ── BudgetTracker ─────────────────────────────────────────────────────────────

export class BudgetTracker {
  private db: Database | null = null;
  private dataDir: string;

  /** Fallback in-memory store (keyed by date:projectId) */
  private memorySpend = new Map<string, number>();
  /** WAL for when SQLite is unavailable */
  private wal: WalEntry[] = [];
  private storageAvailable = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  init(): void {
    try {
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
      }

      this.db = new Database(join(this.dataDir, "budget.db"));
      this._migrate();
      this.storageAvailable = true;

      // Drain WAL on recovery
      if (this.wal.length > 0) {
        console.log(`[budget-tracker] Draining ${this.wal.length} WAL entries after storage recovery`);
        for (const entry of this.wal) {
          this._insertRecord(entry.data);
        }
        this.wal = [];
      }
    } catch (err) {
      console.error("[budget-tracker] SQLite init failed — falling back to in-memory:", err);
      this.storageAvailable = false;
    }
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.storageAvailable = false;
  }

  // ── Schema ──────────────────────────────────────────────────────────────────

  private _migrate(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS budget_ledger (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        date TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        goal_id TEXT,
        request_id TEXT NOT NULL,
        tier TEXT NOT NULL,
        estimated_cost REAL NOT NULL,
        actual_cost REAL,
        was_escalated INTEGER NOT NULL DEFAULT 0,
        was_autonomous INTEGER NOT NULL DEFAULT 1
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_budget_ledger_date_project
        ON budget_ledger(date, project_id)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_budget_ledger_date_agent
        ON budget_ledger(date, agent_id)
    `);
  }

  // ── Record insertion ─────────────────────────────────────────────────────────

  private _todayKey(): string {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  }

  private _insertRecord(rec: BudgetRecord): void {
    if (!this.db || !this.storageAvailable) {
      // Queue to WAL
      this.wal.push({ type: "record", data: rec, queuedAt: Date.now() });
      // Also update in-memory spend
      const key = `${this._todayKey()}:${rec.projectId}`;
      const prev = this.memorySpend.get(key) ?? 0;
      this.memorySpend.set(key, prev + rec.estimatedCost);
      return;
    }

    const date = new Date(rec.timestamp).toISOString().slice(0, 10);
    this.db.run(
      `INSERT OR REPLACE INTO budget_ledger
         (id, timestamp, date, agent_id, project_id, goal_id, request_id, tier,
          estimated_cost, actual_cost, was_escalated, was_autonomous)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rec.id,
        rec.timestamp,
        date,
        rec.agentId,
        rec.projectId,
        rec.goalId ?? null,
        rec.requestId,
        rec.tier,
        rec.estimatedCost,
        rec.actualCost ?? null,
        rec.wasEscalated ? 1 : 0,
        rec.wasAutonomous ? 1 : 0,
      ],
    );
  }

  /**
   * budget_tracker: record a new pre-flight estimated spend.
   */
  recordEstimate(params: {
    requestId: string;
    agentId: string;
    projectId: string;
    goalId?: string;
    tier: BudgetTierLevel;
    estimatedCost: number;
    wasEscalated: boolean;
    wasAutonomous: boolean;
  }): BudgetRecord {
    const rec: BudgetRecord = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      agentId: params.agentId,
      projectId: params.projectId,
      goalId: params.goalId ?? null,
      requestId: params.requestId,
      tier: params.tier,
      estimatedCost: params.estimatedCost,
      actualCost: null,
      wasEscalated: params.wasEscalated,
      wasAutonomous: params.wasAutonomous,
    };

    this._insertRecord(rec);
    return rec;
  }

  /**
   * Update a record with actual cost after execution completes.
   */
  recordActual(requestId: string, actualCost: number): void {
    if (!this.db || !this.storageAvailable) return;

    this.db.run(
      "UPDATE budget_ledger SET actual_cost = ? WHERE request_id = ?",
      [actualCost, requestId],
    );
  }

  // ── Budget state queries ──────────────────────────────────────────────────

  /**
   * Return current budget state for the given agent+project combination.
   */
  getBudgetState(agentId: string, projectId: string): BudgetState {
    const today = this._todayKey();

    let projectDailySpend = 0;
    let agentDailySpend = 0;
    let totalDailySpend = 0;

    if (this.db && this.storageAvailable) {
      const projectRow = this.db
        .query<{ total: number }, [string, string]>(
          `SELECT COALESCE(SUM(estimated_cost), 0) AS total
           FROM budget_ledger WHERE date = ? AND project_id = ?`,
        )
        .get(today, projectId);

      const agentRow = this.db
        .query<{ total: number }, [string, string]>(
          `SELECT COALESCE(SUM(estimated_cost), 0) AS total
           FROM budget_ledger WHERE date = ? AND agent_id = ?`,
        )
        .get(today, agentId);

      const totalRow = this.db
        .query<{ total: number }, [string]>(
          `SELECT COALESCE(SUM(estimated_cost), 0) AS total
           FROM budget_ledger WHERE date = ?`,
        )
        .get(today);

      projectDailySpend = projectRow?.total ?? 0;
      agentDailySpend = agentRow?.total ?? 0;
      totalDailySpend = totalRow?.total ?? 0;
    } else {
      // Fallback: use in-memory spend for this project
      projectDailySpend = this.memorySpend.get(`${today}:${projectId}`) ?? 0;
      totalDailySpend = [...this.memorySpend.entries()]
        .filter(([k]) => k.startsWith(today))
        .reduce((sum, [, v]) => sum + v, 0);
    }

    const remainingProjectBudget = Math.max(0, MAX_PROJECT_BUDGET - projectDailySpend);
    const remainingDailyBudget = Math.max(0, MAX_DAILY_BUDGET - totalDailySpend);

    return {
      projectId,
      agentId,
      agentDailySpend,
      projectDailySpend,
      totalDailySpend,
      remainingProjectBudget,
      remainingDailyBudget,
      projectBudgetRatio: remainingProjectBudget / MAX_PROJECT_BUDGET,
      dailyBudgetRatio: remainingDailyBudget / MAX_DAILY_BUDGET,
    };
  }

  /**
   * Return recent records for the given agent+project (for cost_trail in escalations).
   */
  getRecentRecords(agentId: string, projectId: string, limit = 10): BudgetRecord[] {
    if (!this.db || !this.storageAvailable) return [];

    const rows = this.db
      .query<
        {
          id: string;
          timestamp: number;
          agent_id: string;
          project_id: string;
          goal_id: string | null;
          request_id: string;
          tier: string;
          estimated_cost: number;
          actual_cost: number | null;
          was_escalated: number;
          was_autonomous: number;
        },
        [string, string, number]
      >(
        `SELECT id, timestamp, agent_id, project_id, goal_id, request_id,
                tier, estimated_cost, actual_cost, was_escalated, was_autonomous
         FROM budget_ledger
         WHERE agent_id = ? AND project_id = ?
         ORDER BY timestamp DESC, rowid DESC LIMIT ?`,
      )
      .all(agentId, projectId, limit);

    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      agentId: r.agent_id,
      projectId: r.project_id,
      goalId: r.goal_id,
      requestId: r.request_id,
      tier: r.tier as BudgetTierLevel,
      estimatedCost: r.estimated_cost,
      actualCost: r.actual_cost,
      wasEscalated: r.was_escalated === 1,
      wasAutonomous: r.was_autonomous === 1,
    }));
  }

  /** daily_budget: sum of all estimated spend today for a project */
  getProjectDailySpend(projectId: string): number {
    return this.getBudgetState("__any__", projectId).projectDailySpend;
  }

  /** Total daily spend across all projects today */
  getTotalDailySpend(): number {
    const today = this._todayKey();
    if (!this.db || !this.storageAvailable) {
      return [...this.memorySpend.entries()]
        .filter(([k]) => k.startsWith(today))
        .reduce((sum, [, v]) => sum + v, 0);
    }

    const row = this.db
      .query<{ total: number }, [string]>(
        `SELECT COALESCE(SUM(estimated_cost), 0) AS total FROM budget_ledger WHERE date = ?`,
      )
      .get(today);

    return row?.total ?? 0;
  }
}
