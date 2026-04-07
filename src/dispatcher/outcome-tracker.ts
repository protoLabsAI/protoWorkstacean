/**
 * OutcomeTracker — records action dispatch outcomes for audit and introspection.
 *
 * Keeps a bounded history of recent outcomes (configurable max size).
 */

export type OutcomeStatus = "success" | "failure" | "timeout";

export interface OutcomeRecord {
  correlationId: string;
  actionId: string;
  goalId: string;
  status: OutcomeStatus;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  error?: string;
}

export class OutcomeTracker {
  private readonly records: OutcomeRecord[] = [];

  constructor(private readonly maxHistory = 500) {}

  /** Record a completed outcome. */
  record(entry: OutcomeRecord): void {
    this.records.push(entry);
    if (this.records.length > this.maxHistory) {
      this.records.shift();
    }
  }

  /** Get all recorded outcomes. */
  getAll(): readonly OutcomeRecord[] {
    return this.records;
  }

  /** Get the most recent N outcomes. */
  getRecent(n: number): readonly OutcomeRecord[] {
    return this.records.slice(-n);
  }

  /** Get outcomes for a specific goal. */
  getByGoal(goalId: string): readonly OutcomeRecord[] {
    return this.records.filter((r) => r.goalId === goalId);
  }

  /** Get outcomes for a specific action. */
  getByAction(actionId: string): readonly OutcomeRecord[] {
    return this.records.filter((r) => r.actionId === actionId);
  }

  /** Count outcomes by status. */
  summary(): { success: number; failure: number; timeout: number; total: number } {
    const result = { success: 0, failure: 0, timeout: 0, total: this.records.length };
    for (const r of this.records) {
      result[r.status]++;
    }
    return result;
  }

  /** Clear all recorded outcomes. */
  clear(): void {
    this.records.length = 0;
  }
}
