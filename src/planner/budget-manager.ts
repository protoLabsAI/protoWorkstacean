/**
 * Budget manager for anytime planning.
 * Tracks time and expansion budgets, reports remaining capacity.
 */

import type { BudgetConfig, BudgetStatus } from "./types.ts";

export class BudgetManager {
  private startTime: number;
  private expansionsUsed = 0;
  private readonly timeBudgetMs: number;
  private readonly maxExpansions: number;

  constructor(config: BudgetConfig) {
    this.timeBudgetMs = config.timeBudgetMs;
    this.maxExpansions = config.maxExpansions ?? Infinity;
    this.startTime = Date.now();
  }

  /** Reset the budget timer (for resumption). */
  reset(): void {
    this.startTime = Date.now();
    this.expansionsUsed = 0;
  }

  /** Record that one node was expanded. */
  recordExpansion(): void {
    this.expansionsUsed++;
  }

  /** Get current budget status. */
  status(): BudgetStatus {
    const elapsedMs = Date.now() - this.startTime;
    return {
      elapsedMs,
      expansionsUsed: this.expansionsUsed,
      timeRemaining: Math.max(0, this.timeBudgetMs - elapsedMs),
      isExhausted: elapsedMs >= this.timeBudgetMs || this.expansionsUsed >= this.maxExpansions,
    };
  }

  /** Check if any budget remains. */
  hasRemaining(): boolean {
    return !this.status().isExhausted;
  }

  /** Get remaining time budget in ms. */
  remainingTimeMs(): number {
    return Math.max(0, this.timeBudgetMs - (Date.now() - this.startTime));
  }

  /** Get remaining expansion budget. */
  remainingExpansions(): number {
    return Math.max(0, this.maxExpansions - this.expansionsUsed);
  }
}
