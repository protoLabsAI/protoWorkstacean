import type { GoalViolation } from "./goals.ts";
import type { WorldState } from "../../lib/types/world-state.ts";

export interface GoalViolatedEventPayload {
  type: "world.goal.violated";
  violation: GoalViolation;
  worldState?: WorldState;
}
