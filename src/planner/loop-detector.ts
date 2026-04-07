/**
 * LoopDetector — anti-oscillation detection for the L0 planner.
 *
 * Tracks failed action attempts per (goalId, actionId) combination.
 * When N failures occur within an M-minute window, isOscillating() returns true,
 * which triggers escalation to a higher tier instead of retrying at L0.
 */

export interface LoopDetectorConfig {
  /** Maximum number of failures within the window before oscillation is detected. */
  maxAttempts: number;
  /** Sliding window length in minutes. */
  windowMinutes: number;
}

export interface AttemptRecord {
  timestamp: number;
  goalId: string;
  actionId: string;
  succeeded: boolean;
}

export class LoopDetector {
  private readonly attempts = new Map<string, AttemptRecord[]>();

  constructor(private readonly config: LoopDetectorConfig) {
    if (config.maxAttempts < 1) throw new Error("maxAttempts must be >= 1");
    if (config.windowMinutes <= 0) throw new Error("windowMinutes must be > 0");
  }

  /** Record an action attempt outcome. */
  record(goalId: string, actionId: string, succeeded: boolean): void {
    const key = this.key(goalId, actionId);
    const records = this.attempts.get(key) ?? [];
    records.push({ timestamp: Date.now(), goalId, actionId, succeeded });
    this.attempts.set(key, records);
  }

  /**
   * Returns true if the failure count within the sliding window
   * has reached or exceeded maxAttempts.
   */
  isOscillating(goalId: string, actionId: string): boolean {
    const key = this.key(goalId, actionId);
    const records = this.attempts.get(key);
    if (!records || records.length === 0) return false;

    const windowMs = this.config.windowMinutes * 60 * 1000;
    const cutoff = Date.now() - windowMs;

    const recentFailures = records.filter((r) => !r.succeeded && r.timestamp >= cutoff);
    return recentFailures.length >= this.config.maxAttempts;
  }

  /** Return all attempt records for a (goalId, actionId) pair. */
  getHistory(goalId: string, actionId: string): AttemptRecord[] {
    return this.attempts.get(this.key(goalId, actionId)) ?? [];
  }

  /**
   * Return only the recent failure records within the detection window.
   * Useful for oscillation event payloads.
   */
  getRecentFailures(goalId: string, actionId: string): AttemptRecord[] {
    const windowMs = this.config.windowMinutes * 60 * 1000;
    const cutoff = Date.now() - windowMs;
    return this.getHistory(goalId, actionId).filter(
      (r) => !r.succeeded && r.timestamp >= cutoff
    );
  }

  /** Reset all attempt records for a (goalId, actionId) pair. */
  clear(goalId: string, actionId: string): void {
    this.attempts.delete(this.key(goalId, actionId));
  }

  /** Reset all recorded attempts. */
  clearAll(): void {
    this.attempts.clear();
  }

  private key(goalId: string, actionId: string): string {
    return `${goalId}:${actionId}`;
  }
}
