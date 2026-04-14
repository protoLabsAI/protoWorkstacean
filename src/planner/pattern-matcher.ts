/**
 * PatternMatcher — evaluates action preconditions against a WorldState snapshot.
 *
 * Returns matching actions ranked by: priority desc → blast asc → confidence desc → cost asc → random tie-break.
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
 * Returns only actions whose preconditions are all satisfied, ranked by:
 *   1. Priority descending (higher = more urgent)
 *   2. Blast ascending (lower blast radius = fewer side effects)
 *   3. Confidence descending (higher confidence = more reliable effects)
 *   4. Cost ascending (lower cost = cheaper)
 *   5. Random tie-break (round-robin among exact ties to avoid starving any agent)
 */
export function matchActions(actions: Action[], worldState: WorldState): Action[] {
  const matching = actions.filter((a) => actionMatches(a, worldState));
  // Attach a random key before sorting so exact ties are broken by round-robin.
  const withRand = matching.map((a) => ({ action: a, rand: Math.random() }));
  withRand.sort((x, y) => {
    const a = x.action;
    const b = y.action;
    if (b.priority !== a.priority) return b.priority - a.priority;
    const blastA = a.blast ?? 0;
    const blastB = b.blast ?? 0;
    if (blastA !== blastB) return blastA - blastB;
    const confA = a.confidence ?? 1.0;
    const confB = b.confidence ?? 1.0;
    if (confA !== confB) return confB - confA;
    if (a.cost !== b.cost) return a.cost - b.cost;
    return x.rand - y.rand;
  });
  return withRand.map((x) => x.action);
}
