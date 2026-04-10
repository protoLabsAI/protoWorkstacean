/**
 * EscalationRouter — persistent store for HITL escalation records.
 *
 * Persists escalation state to workspace/state/escalations.json so that
 * pending escalations survive server restarts.
 *
 * Failure mode (bug fix):
 *   If escalations.json is corrupt (truncated write, disk error, etc.) the
 *   server previously crashed at startup with a JSON parse error. This class
 *   catches the SyntaxError, logs a warning, resets the file to an empty
 *   store, and continues — ensuring the escalation subsystem is never
 *   silently broken on restart.
 *
 * Storage: {stateDir}/escalations.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

// ── Store schema ──────────────────────────────────────────────────────────────

export interface EscalationRecord {
  id: string;
  correlationId: string;
  agentId: string;
  projectId: string;
  goalId: string | null;
  tier: string;
  escalationReason: string;
  estimatedCost: number;
  createdAt: number;
  expiresAt: number;
  decision?: "approve" | "reject" | "modify";
  decidedBy?: string;
  decidedAt?: number;
}

interface EscalationStore {
  version: 1;
  escalations: EscalationRecord[];
}

const EMPTY_STORE: EscalationStore = { version: 1, escalations: [] };

// ── Validation ────────────────────────────────────────────────────────────────

function isValidStore(value: unknown): value is EscalationStore {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (!Array.isArray(v.escalations)) return false;
  return true;
}

// ── EscalationRouter ──────────────────────────────────────────────────────────

export class EscalationRouter {
  private store: EscalationStore = { ...EMPTY_STORE, escalations: [] };
  private readonly statePath: string;

  constructor(stateDir: string) {
    this.statePath = join(stateDir, "escalations.json");
    this._load();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /**
   * Record a new escalation.
   * Returns the stored record (with generated id if not provided).
   */
  add(record: EscalationRecord): EscalationRecord {
    this.store.escalations.push(record);
    this._persist();
    return record;
  }

  /**
   * Record a decision on an existing escalation.
   * Returns false if the escalation id was not found.
   */
  decide(
    id: string,
    decision: EscalationRecord["decision"],
    decidedBy: string,
  ): boolean {
    const rec = this.store.escalations.find((e) => e.id === id);
    if (!rec) return false;
    rec.decision = decision;
    rec.decidedBy = decidedBy;
    rec.decidedAt = Date.now();
    this._persist();
    return true;
  }

  /**
   * Remove expired escalations (expiresAt < now).
   * Returns the number of records removed.
   */
  pruneExpired(): number {
    const now = Date.now();
    const before = this.store.escalations.length;
    this.store.escalations = this.store.escalations.filter((e) => e.expiresAt >= now);
    const removed = before - this.store.escalations.length;
    if (removed > 0) this._persist();
    return removed;
  }

  /** Get all escalations (optionally filtered to pending — no decision yet). */
  getAll(pendingOnly = false): readonly EscalationRecord[] {
    if (pendingOnly) {
      return this.store.escalations.filter((e) => e.decision === undefined);
    }
    return this.store.escalations;
  }

  /** Get a single escalation by id. */
  getById(id: string): EscalationRecord | undefined {
    return this.store.escalations.find((e) => e.id === id);
  }

  /** Get escalation by correlationId (HITL request tracking). */
  getByCorrelationId(correlationId: string): EscalationRecord | undefined {
    return this.store.escalations.find((e) => e.correlationId === correlationId);
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  private _load(): void {
    if (!existsSync(this.statePath)) return;

    let raw: string;
    try {
      raw = readFileSync(this.statePath, "utf8");
    } catch (err) {
      console.warn("[escalation-router] Could not read escalations.json — starting with empty store:", err);
      return;
    }

    // Validate that the file has content before attempting to parse
    if (!raw || raw.trim().length === 0) {
      console.warn("[escalation-router] escalations.json is empty — starting with empty store");
      this._persist();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      console.warn(
        "[escalation-router] escalations.json contains corrupt JSON — resetting to empty store.",
        err,
      );
      this.store = { ...EMPTY_STORE, escalations: [] };
      this._persist();
      return;
    }

    if (!isValidStore(parsed)) {
      console.warn(
        "[escalation-router] escalations.json failed schema validation — resetting to empty store.",
        { parsed },
      );
      this.store = { ...EMPTY_STORE, escalations: [] };
      this._persist();
      return;
    }

    this.store = parsed;
  }

  private _persist(): void {
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.statePath, JSON.stringify(this.store, null, 2), "utf8");
  }
}
