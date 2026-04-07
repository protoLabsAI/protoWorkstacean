/**
 * Immutable world state utilities for the planner.
 * Provides cloning, comparison, and hashing for PlannerState.
 */

import type { PlannerState, StateValue } from "./types.ts";

/** Create a deep clone of a planner state. */
export function cloneState(state: PlannerState): PlannerState {
  return { ...state };
}

/** Apply a set of key-value updates to a state, returning a new state. */
export function applyUpdate(
  state: PlannerState,
  updates: Record<string, StateValue>,
): PlannerState {
  return { ...state, ...updates };
}

/**
 * Produce a deterministic hash key for a planner state.
 * Keys are sorted alphabetically for consistency.
 */
export function stateKey(state: PlannerState): string {
  const keys = Object.keys(state).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${k}=${String(state[k])}`);
  }
  return parts.join("|");
}

/** Check if two planner states are equal (same keys and values). */
export function statesEqual(a: PlannerState, b: PlannerState): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (a[aKeys[i]] !== b[bKeys[i]]) return false;
  }
  return true;
}

/** Create an empty planner state. */
export function emptyState(): PlannerState {
  return Object.freeze({});
}

/** Create a planner state from key-value pairs. */
export function createState(
  entries: Record<string, StateValue>,
): PlannerState {
  return Object.freeze({ ...entries });
}

/** Get a subset of state keys. */
export function projectState(
  state: PlannerState,
  keys: string[],
): PlannerState {
  const result: Record<string, StateValue> = {};
  for (const k of keys) {
    if (k in state) {
      result[k] = state[k];
    }
  }
  return Object.freeze(result);
}
