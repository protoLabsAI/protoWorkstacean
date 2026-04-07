/**
 * CooldownManager — per (goalId, actionId) cooldown tracking.
 *
 * After a failed attempt or oscillation escalation, a cooldown can be set
 * to prevent immediate re-dispatch of the same action.
 */

export class CooldownManager {
  /** Map of `goalId:actionId` → expiry timestamp (ms). */
  private readonly cooldowns = new Map<string, number>();

  /** Set a cooldown for a (goalId, actionId) pair. */
  setCooldown(goalId: string, actionId: string, durationMs: number): void {
    if (durationMs <= 0) return;
    this.cooldowns.set(this.key(goalId, actionId), Date.now() + durationMs);
  }

  /**
   * Returns true if the pair is currently on cooldown.
   * Automatically clears expired cooldowns on read.
   */
  isOnCooldown(goalId: string, actionId: string): boolean {
    const k = this.key(goalId, actionId);
    const expiry = this.cooldowns.get(k);
    if (expiry === undefined) return false;
    if (Date.now() >= expiry) {
      this.cooldowns.delete(k);
      return false;
    }
    return true;
  }

  /** Return ms remaining on cooldown, or 0 if not on cooldown. */
  remainingMs(goalId: string, actionId: string): number {
    const k = this.key(goalId, actionId);
    const expiry = this.cooldowns.get(k);
    if (expiry === undefined) return 0;
    const remaining = expiry - Date.now();
    if (remaining <= 0) {
      this.cooldowns.delete(k);
      return 0;
    }
    return remaining;
  }

  /** Immediately remove the cooldown for a (goalId, actionId) pair. */
  clearCooldown(goalId: string, actionId: string): void {
    this.cooldowns.delete(this.key(goalId, actionId));
  }

  /** Clear all active cooldowns. */
  clearAll(): void {
    this.cooldowns.clear();
  }

  /** Number of active (non-expired) cooldowns. */
  get size(): number {
    const now = Date.now();
    let count = 0;
    for (const expiry of this.cooldowns.values()) {
      if (now < expiry) count++;
    }
    return count;
  }

  private key(goalId: string, actionId: string): string {
    return `${goalId}:${actionId}`;
  }
}
