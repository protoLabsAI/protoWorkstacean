import { describe, test, expect } from "bun:test";
import { TOPICS } from "./topics.ts";
import type {
  ActionDispatchPayload,
  PlannerEscalatePayload,
} from "./action-events.ts";
import type { AutonomousOutcomePayload } from "./payloads.ts";

describe("EventBus Topics", () => {
  test("all expected topics are defined", () => {
    expect(TOPICS.WORLD_STATE_UPDATED).toBe("world.state.updated");
    expect(TOPICS.WORLD_ACTION_DISPATCH).toBe("world.action.dispatch");
    expect(TOPICS.WORLD_ACTION_OSCILLATION).toBe("world.action.oscillation");
    expect(TOPICS.WORLD_ACTION_QUEUE_FULL).toBe("world.action.queue_full");
    expect(TOPICS.PLANNER_ESCALATE).toBe("world.planner.escalate");
    expect(TOPICS.AUTONOMOUS_OUTCOME_PREFIX).toBe("autonomous.outcome");
  });

  test("dispatch + oscillation + queue_full stay under world.action.*", () => {
    const actionTopics = [
      TOPICS.WORLD_ACTION_DISPATCH,
      TOPICS.WORLD_ACTION_OSCILLATION,
      TOPICS.WORLD_ACTION_QUEUE_FULL,
    ];
    for (const topic of actionTopics) {
      expect(topic).toMatch(/^world\.action\./);
    }
  });
});

describe("ActionDispatchPayload", () => {
  test("satisfies type contract at compile time", () => {
    const payload: ActionDispatchPayload = {
      type: "dispatch",
      actionId: "act-1",
      goalId: "goal-1",
      action: {
        id: "act-1",
        name: "Test",
        description: "",
        goalId: "goal-1",
        tier: "tier_0",
        preconditions: [],
        effects: [],
        cost: 0,
        priority: 0,
        meta: {},
      },
      correlationId: "corr-1",
      timestamp: Date.now(),
      optimisticEffectsApplied: true,
    };
    expect(payload.type).toBe("dispatch");
    expect(payload.optimisticEffectsApplied).toBe(true);
  });
});

describe("AutonomousOutcomePayload", () => {
  test("success outcome with goap context", () => {
    const payload: AutonomousOutcomePayload = {
      correlationId: "corr-1",
      systemActor: "goap",
      skill: "unblock_feature",
      actionId: "act-1",
      goalId: "goal-1",
      success: true,
      taskState: "completed",
      durationMs: 150,
    };
    expect(payload.success).toBe(true);
    expect(payload.error).toBeUndefined();
    expect(payload.actionId).toBe("act-1");
    expect(payload.goalId).toBe("goal-1");
  });

  test("failure outcome with error", () => {
    const payload: AutonomousOutcomePayload = {
      correlationId: "corr-1",
      systemActor: "goap",
      skill: "unblock_feature",
      actionId: "act-1",
      goalId: "goal-1",
      success: false,
      error: "Precondition check failed",
      taskState: "failed",
      durationMs: 10,
    };
    expect(payload.success).toBe(false);
    expect(payload.error).toBe("Precondition check failed");
  });

  test("ceremony-originated outcome (no actionId/goalId)", () => {
    const payload: AutonomousOutcomePayload = {
      correlationId: "corr-2",
      systemActor: "ceremony",
      skill: "daily_sitrep",
      success: true,
      taskState: "completed",
      durationMs: 2500,
    };
    expect(payload.systemActor).toBe("ceremony");
    expect(payload.actionId).toBeUndefined();
    expect(payload.goalId).toBeUndefined();
  });
});

describe("PlannerEscalatePayload", () => {
  test("escalation to tier_1", () => {
    const payload: PlannerEscalatePayload = {
      type: "escalate",
      goalId: "goal-1",
      correlationId: "corr-1",
      timestamp: Date.now(),
      reason: "Preconditions failed at dispatch time",
      escalateTo: "tier_1",
    };
    expect(payload.escalateTo).toBe("tier_1");
  });
});
