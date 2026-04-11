/**
 * State cache — caches evaluated states in the closed set for reuse.
 * Optimizes state comparison and lookup.
 */

import type { PlannerState, SearchNode } from "./types.ts";

/** Cached state entry with metadata. */
export interface CachedState {
  state: PlannerState;
  key: string;
  bestGScore: number;
  node: SearchNode;
}

export class StateCache {
  private cache = new Map<string, CachedState>();

  /** Add or update a state in the cache. */
  put(node: SearchNode): void {
    const existing = this.cache.get(node.stateKey);
    if (existing && existing.bestGScore <= node.gScore) return;

    this.cache.set(node.stateKey, {
      state: node.state,
      key: node.stateKey,
      bestGScore: node.gScore,
      node,
    });
  }

  /** Look up a state by its key. */
  get(key: string): CachedState | undefined {
    return this.cache.get(key);
  }

  /** Check if a state has been visited with a better or equal g-score. */
  hasBetterOrEqual(key: string, gScore: number): boolean {
    const existing = this.cache.get(key);
    return existing !== undefined && existing.bestGScore <= gScore;
  }

  /** Check if a state key is in the cache. */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /** Clear the cache. */
  clear(): void {
    this.cache.clear();
  }

  /** Get the number of cached states. */
  get size(): number {
    return this.cache.size;
  }
}
