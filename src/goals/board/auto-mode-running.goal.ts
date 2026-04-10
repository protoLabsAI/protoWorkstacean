/**
 * board.auto_mode_running — first L0 deterministic goal.
 *
 * Tier: tier_0 (deterministic, free)
 * Cost: 0
 *
 * This goal marks the planner's auto mode as running when the board domain
 * is available in the world state. It's a startup goal that sets the
 * extensions.planner.auto_mode_running flag.
 *
 * Precondition:  board domain exists in world state
 *                AND extensions.planner.auto_mode_running is not already true
 * Effect:        set extensions.planner.auto_mode_running = true
 *                set extensions.planner.auto_mode_started_at = timestamp
 */

import type { Action } from "../../planner/types/action.ts";

export const GOAL_ID = "board.auto_mode_running";

/** The single tier_0 action that fulfils the board.auto_mode_running goal. */
export const boardAutoModeRunningAction: Action = {
  id: "board.auto_mode_running.activate",
  name: "Activate board auto mode",
  description:
    "Marks board auto mode as running when the board domain is available " +
    "and auto mode is not yet active.",
  goalId: GOAL_ID,
  tier: "tier_0",
  preconditions: [
    // Board domain must be present in world state
    { path: "domains.board", operator: "exists" },
    // Auto mode must not already be running (avoids re-triggering)
    { path: "extensions.planner.auto_mode_running", operator: "not_exists" },
  ],
  effects: [
    { path: "planner.auto_mode_running", operation: "set", value: true },
    { path: "planner.auto_mode_started_at", operation: "set", value: "__timestamp__" },
  ],
  cost: 0,
  priority: 10,
  meta: {
    // No agent topic — tier_0 actions are resolved immediately by the dispatcher
  },
};

/** Register the board.auto_mode_running action into an ActionRegistry. */
export function registerBoardAutoModeRunningGoal(
  registry: import("../../planner/action-registry.ts").ActionRegistry
): void {
  registry.upsert(boardAutoModeRunningAction);
}
