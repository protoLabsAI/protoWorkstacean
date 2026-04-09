/**
 * Memoization cache for heuristic calculations.
 * Caches heuristic values by state key to avoid redundant computation.
 */

import type { Goal, PlannerState } from "./types.ts";
import type { HeuristicFn } from "./heuristic.ts";
import { stateKey } from "./world-state.ts";

/**
 * Wrap a heuristic function with memoization.
 * Cached values are keyed by the state's deterministic hash.
 */
export function memoizeHeuristic(
  heuristic: HeuristicFn,
  maxSize = 10000,
): HeuristicFn {
  const cache = new Map<string, number>();

  return (state: PlannerState, goal: Goal): number => {
    const key = stateKey(state);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const value = heuristic(state, goal);

    // Evict oldest entries if cache is full
    if (cache.size >= maxSize) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) {
        cache.delete(firstKey);
      }
    }

    cache.set(key, value);
    return value;
  };
}

/** A standalone memo cache for arbitrary key-value pairs. */
export class MemoCache<V> {
  private cache = new Map<string, V>();
  private maxSize: number;

  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
  }

  get(key: string): V | undefined {
    return this.cache.get(key);
  }

  set(key: string, value: V): void {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
