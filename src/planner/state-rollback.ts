/**
 * StateRollback — tracks applied optimistic state updates and provides recovery.
 *
 * Maintains a per-correlationId registry of rollback functions.
 * On action failure, calling rollback(correlationId) restores the previous state.
 */

import type { WorldState } from "../../lib/types/world-state.ts";

export interface RollbackEntry {
  correlationId: string;
  actionId: string;
  appliedAt: number;
  rollback: () => WorldState;
}

export class StateRollbackRegistry {
  private readonly entries = new Map<string, RollbackEntry>();

  /** Register a rollback function for a dispatched action. */
  register(correlationId: string, actionId: string, rollback: () => WorldState): void {
    this.entries.set(correlationId, {
      correlationId,
      actionId,
      appliedAt: Date.now(),
      rollback,
    });
  }

  /**
   * Execute the rollback for a given correlationId.
   * Returns the original WorldState, or undefined if no entry found.
   */
  rollback(correlationId: string): WorldState | undefined {
    const entry = this.entries.get(correlationId);
    if (!entry) return undefined;
    this.entries.delete(correlationId);
    return entry.rollback();
  }

  /** Discard the rollback entry (action succeeded — no need to roll back). */
  commit(correlationId: string): void {
    this.entries.delete(correlationId);
  }

  /** Return all pending (uncommitted) rollback entries. */
  pending(): RollbackEntry[] {
    return Array.from(this.entries.values());
  }

  /** Number of pending rollback entries. */
  get size(): number {
    return this.entries.size;
  }

  /** Clear all pending entries (e.g., on full resync). */
  clearAll(): void {
    this.entries.clear();
  }
}
