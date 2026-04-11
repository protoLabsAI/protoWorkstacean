/**
 * HTN (Hierarchical Task Network) decomposer.
 *
 * Decomposes high-level tasks through the portfolio→project→domain→action
 * hierarchy, producing primitive action sequences for the A* planner.
 */

import type { Action, HierarchyLevel, PlannerState } from "./types.ts";
import { HIERARCHY_ORDER } from "./types.ts";
import { TaskNetwork } from "./task-network.ts";
import { isPrimitiveLevel } from "./hierarchy-levels.ts";

/** Result of HTN decomposition. */
export interface DecompositionResult {
  success: boolean;
  actions: Action[];
  /** Path of decomposition steps taken. */
  decompositionPath: string[];
  error?: string;
}

export class HTNDecomposer {
  private network: TaskNetwork;

  constructor(network: TaskNetwork) {
    this.network = network;
  }

  /**
   * Decompose a task at any level into primitive actions.
   *
   * Walks down the hierarchy: portfolio→project→domain→action.
   * At each level, the composite task's decompose function determines
   * which sub-tasks to expand.
   */
  decompose(taskId: string, state: PlannerState): DecompositionResult {
    const path: string[] = [taskId];
    const actions = this.network.decompose(taskId, state);

    if (actions === null) {
      return {
        success: false,
        actions: [],
        decompositionPath: path,
        error: `Failed to decompose task "${taskId}"`,
      };
    }

    return {
      success: true,
      actions,
      decompositionPath: path,
    };
  }

  /**
   * Decompose all applicable tasks at a given hierarchy level.
   * Returns the union of all primitive actions produced.
   */
  decomposeLevel(level: HierarchyLevel, state: PlannerState): DecompositionResult {
    if (isPrimitiveLevel(level)) {
      // At action level, just return all applicable primitive actions
      const primitives = this.network.getPrimitiveActions();
      return {
        success: true,
        actions: primitives,
        decompositionPath: [level],
      };
    }

    const tasks = this.network.getTasksAtLevel(level);
    const allActions: Action[] = [];
    const path: string[] = [level];

    for (const entry of tasks) {
      if (entry.type !== "composite") continue;

      const composite = entry.task;
      if (composite.precondition && !composite.precondition(state)) continue;

      const result = this.decompose(composite.id, state);
      if (result.success) {
        allActions.push(...result.actions);
        path.push(...result.decompositionPath);
      }
    }

    return {
      success: allActions.length > 0,
      actions: allActions,
      decompositionPath: path,
    };
  }

  /**
   * Full top-down decomposition: start from portfolio level and decompose
   * all the way down to primitive actions.
   */
  fullDecomposition(state: PlannerState): DecompositionResult {
    const allActions: Action[] = [];
    const path: string[] = [];

    for (const level of HIERARCHY_ORDER) {
      if (isPrimitiveLevel(level)) {
        // Collect remaining primitive actions not yet gathered
        const primitives = this.network.getPrimitiveActions();
        for (const a of primitives) {
          if (!allActions.some((existing) => existing.id === a.id)) {
            allActions.push(a);
          }
        }
        path.push(level);
        continue;
      }

      const result = this.decomposeLevel(level, state);
      if (result.success) {
        for (const a of result.actions) {
          if (!allActions.some((existing) => existing.id === a.id)) {
            allActions.push(a);
          }
        }
        path.push(...result.decompositionPath);
      }
    }

    return {
      success: allActions.length > 0,
      actions: allActions,
      decompositionPath: path,
    };
  }

  /** Get the underlying task network. */
  getNetwork(): TaskNetwork {
    return this.network;
  }
}
