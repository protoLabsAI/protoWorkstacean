/**
 * DispatchQueue — WIP-limited action queue for ActionDispatcherPlugin.
 *
 * Enforces a configurable concurrency limit (wipLimit).
 * Actions that exceed the limit are queued in priority order.
 * Applies backpressure signal and publishes world.action.queue_full when full.
 */

import type { Action } from "../planner/types/action.ts";

export interface QueuedAction {
  action: Action;
  correlationId: string;
  enqueuedAt: number;
}

export interface DispatchQueueConfig {
  /** Maximum number of concurrently active (in-flight) actions. */
  wipLimit: number;
}

export class DispatchQueue {
  private readonly active = new Set<string>(); // correlationIds in-flight
  private readonly pending: QueuedAction[] = [];

  constructor(private readonly config: DispatchQueueConfig) {
    if (config.wipLimit < 1) throw new Error("wipLimit must be >= 1");
  }

  /** Number of in-flight actions. */
  get activeCount(): number {
    return this.active.size;
  }

  /** Number of queued-but-not-yet-dispatched actions. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /** True when active count has reached the WIP limit. */
  get isAtCapacity(): boolean {
    return this.active.size >= this.config.wipLimit;
  }

  /** Configured WIP limit. */
  get wipLimit(): number {
    return this.config.wipLimit;
  }

  /**
   * Attempt to dispatch an action immediately.
   * Returns true if dispatched (slot available), false if queued (WIP limit reached).
   */
  tryDispatch(action: Action, correlationId: string): boolean {
    if (this.active.size < this.config.wipLimit) {
      this.active.add(correlationId);
      return true;
    }
    // Queue in priority order (higher priority = earlier in array)
    const item: QueuedAction = { action, correlationId, enqueuedAt: Date.now() };
    const insertAt = this.pending.findIndex((p) => p.action.priority < action.priority);
    if (insertAt === -1) {
      this.pending.push(item);
    } else {
      this.pending.splice(insertAt, 0, item);
    }
    return false;
  }

  /**
   * Mark an in-flight action as complete (success or failure).
   * Returns the next queued action if one is ready, or undefined.
   */
  complete(correlationId: string): QueuedAction | undefined {
    this.active.delete(correlationId);
    if (this.pending.length > 0 && this.active.size < this.config.wipLimit) {
      const next = this.pending.shift()!;
      this.active.add(next.correlationId);
      return next;
    }
    return undefined;
  }

  /** Return all pending queued actions (read-only view). */
  getPending(): readonly QueuedAction[] {
    return this.pending;
  }

  /** Return all active correlationIds. */
  getActive(): string[] {
    return Array.from(this.active);
  }

  /** Cancel a pending action by correlationId. Returns true if found and removed. */
  cancelPending(correlationId: string): boolean {
    const idx = this.pending.findIndex((p) => p.correlationId === correlationId);
    if (idx !== -1) {
      this.pending.splice(idx, 1);
      return true;
    }
    return false;
  }

  /** Clear all pending and active state. */
  reset(): void {
    this.active.clear();
    this.pending.length = 0;
  }
}
