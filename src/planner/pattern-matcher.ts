/**
 * PatternMatcher — evaluates action preconditions against a WorldState snapshot.
 *
 * Returns matching actions sorted by priority (descending), then cost (ascending).
 * Deterministic: same inputs always produce the same output.
 */

import type { Action, Precondition } from "./types/action.ts";
import type { WorldState } from "../../lib/types/world-state.ts";

/** Resolve a dot-notation path within an object. Returns undefined if any segment is missing. */
export function resolvePath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Evaluate a single precondition against a WorldState. */
export function evaluatePrecondition(p: Precondition, worldState: WorldState): boolean {
  const actual = resolvePath(worldState, p.path);

  switch (p.operator) {
    case "exists":
      return actual !== undefined && actual !== null;
    case "not_exists":
      return actual === undefined || actual === null;
    case "eq":
      return actual === p.value;
    case "neq":
      return actual !== p.value;
    case "gt":
      return typeof actual === "number" && actual > (p.value as number);
    case "gte":
      return typeof actual === "number" && actual >= (p.value as number);
    case "lt":
      return typeof actual === "number" && actual < (p.value as number);
    case "lte":
      return typeof actual === "number" && actual <= (p.value as number);
    default:
      return false;
  }
}

/** Evaluate all preconditions for an action. Returns true only if all pass. */
export function actionMatches(action: Action, worldState: WorldState): boolean {
  return action.preconditions.every((p) => evaluatePrecondition(p, worldState));
}

/**
 * Match a list of actions against the current WorldState.
 *
 * Returns only actions whose preconditions are all satisfied,
 * sorted by priority descending, then cost ascending (deterministic tie-break).
 */
export function matchActions(actions: Action[], worldState: WorldState): Action[] {
  const matching = actions.filter((a) => actionMatches(a, worldState));
  return matching.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.cost - b.cost;
  });
}
