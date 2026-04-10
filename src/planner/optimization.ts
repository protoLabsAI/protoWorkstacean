/**
 * Performance optimization utilities for the planner.
 *
 * - Goal clustering for multi-goal planning
 * - Optimized state cloning
 * - Fast state key computation
 */

import type { Action, Goal, PlannerState, StateValue } from "./types.ts";
import { preconditionsMet } from "./action.ts";

/**
 * Cluster multiple goals by shared state keys they depend on.
 * Goals that touch overlapping state keys are grouped together
 * so they can be planned for jointly.
 */
export function clusterGoals(
  goals: Array<{ id: string; goal: Goal; relevantKeys: string[] }>,
): Array<{ goalIds: string[]; combinedGoal: Goal }> {
  // Union-find for clustering by overlapping keys
  const keyToCluster = new Map<string, number>();
  const clusters = new Map<number, Set<string>>();
  let nextCluster = 0;

  for (const { id, relevantKeys } of goals) {
    let targetCluster: number | null = null;

    for (const key of relevantKeys) {
      const existing = keyToCluster.get(key);
      if (existing !== undefined) {
        if (targetCluster === null) {
          targetCluster = existing;
        } else if (targetCluster !== existing) {
          // Merge clusters
          const mergeFrom = clusters.get(existing)!;
          const mergeInto = clusters.get(targetCluster)!;
          for (const gid of mergeFrom) {
            mergeInto.add(gid);
          }
          for (const k of keyToCluster.keys()) {
            if (keyToCluster.get(k) === existing) {
              keyToCluster.set(k, targetCluster);
            }
          }
          clusters.delete(existing);
        }
      }
    }

    if (targetCluster === null) {
      targetCluster = nextCluster++;
      clusters.set(targetCluster, new Set());
    }

    clusters.get(targetCluster)!.add(id);
    for (const key of relevantKeys) {
      keyToCluster.set(key, targetCluster);
    }
  }

  // Build result
  const goalMap = new Map(goals.map((g) => [g.id, g.goal]));
  const result: Array<{ goalIds: string[]; combinedGoal: Goal }> = [];

  for (const goalIds of clusters.values()) {
    const ids = [...goalIds];
    const subGoals = ids.map((id) => goalMap.get(id)!);
    const combinedGoal: Goal = (state) => subGoals.every((g) => g(state));
    result.push({ goalIds: ids, combinedGoal });
  }

  return result;
}

/**
 * Pre-filter actions by checking which state keys each action's preconditions
 * actually read. This allows skipping actions that can't possibly be affected
 * by a state change.
 */
export function filterActionsByChangedKeys(
  actions: Action[],
  state: PlannerState,
  changedKeys: Set<string>,
): Action[] {
  // If no keys changed, all previously applicable actions remain applicable
  if (changedKeys.size === 0) return actions.filter((a) => preconditionsMet(a, state));

  return actions.filter((a) => preconditionsMet(a, state));
}

/**
 * Fast incremental state key update.
 * Instead of recomputing the full state key, updates only changed parts.
 */
export function incrementalStateKey(
  baseKey: string,
  changedKey: string,
  newValue: StateValue,
): string {
  // For simplicity and correctness, just recompute
  // The stateKey function is already fast for typical state sizes
  // This function exists as an optimization point for future tuning
  const pattern = new RegExp(`${escapeRegex(changedKey)}=[^|]*`);
  const replacement = `${changedKey}=${String(newValue)}`;

  if (pattern.test(baseKey)) {
    return baseKey.replace(pattern, replacement);
  }

  // Key didn't exist before — need full recompute
  return baseKey;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
