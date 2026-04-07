import type { GoalViolation } from "./goals.ts";

export interface GoalViolatedEventPayload {
  type: "world.goal.violated";
  violation: GoalViolation;
  worldState?: Record<string, unknown>;
}
