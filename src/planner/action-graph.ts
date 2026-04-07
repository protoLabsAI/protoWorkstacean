/**
 * ActionGraph — maps world states to applicable actions (edges).
 *
 * The action graph is an implicit graph where:
 * - Nodes are PlannerState values
 * - Edges are Actions whose preconditions are satisfied
 * - Successor states are computed by applying action effects
 */

import type { Action, PlannerState } from "./types.ts";
import { preconditionsMet, applyEffects } from "./action.ts";

/** An edge in the action graph: action + resulting state. */
export interface ActionEdge {
  action: Action;
  resultState: PlannerState;
}

export class ActionGraph {
  private actions: Action[] = [];

  /** Register an action in the graph. */
  addAction(a: Action): void {
    this.actions.push(a);
  }

  /** Register multiple actions. */
  addActions(actions: Action[]): void {
    for (const a of actions) {
      this.actions.push(a);
    }
  }

  /** Get all actions whose preconditions are satisfied by the given state. */
  getApplicableActions(state: PlannerState): Action[] {
    return this.actions.filter((a) => preconditionsMet(a, state));
  }

  /** Get all successor edges (action + result state) from the given state. */
  getSuccessors(state: PlannerState): ActionEdge[] {
    const applicable = this.getApplicableActions(state);
    return applicable.map((a) => ({
      action: a,
      resultState: applyEffects(a, state),
    }));
  }

  /** Get all registered actions. */
  getAllActions(): readonly Action[] {
    return this.actions;
  }

  /** Get the number of registered actions. */
  get size(): number {
    return this.actions.length;
  }

  /** Remove an action by ID. */
  removeAction(id: string): boolean {
    const idx = this.actions.findIndex((a) => a.id === id);
    if (idx === -1) return false;
    this.actions.splice(idx, 1);
    return true;
  }
}
