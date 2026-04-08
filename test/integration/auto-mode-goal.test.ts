/**
 * Integration test: board.auto_mode_running goal end-to-end with full orchestrator.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../lib/bus.ts";
import { PlanningOrchestrator } from "../../src/planner/planning-orchestrator.ts";
import { registerBoardAutoModeRunningGoal, GOAL_ID } from "../../src/goals/board/auto-mode-running.goal.ts";
import { TOPICS } from "../../src/event-bus/topics.ts";
import type { ActionOutcomePayload, ActionDispatchPayload } from "../../src/event-bus/action-events.ts";
import type { WorldState } from "../../lib/types/world-state.ts";

const worldStateWithBoard = (): WorldState => ({
  timestamp: Date.now(),
  domains: {
    board: {
      data: {
        projectSlug: "protoWorkstacean",
        openIssues: 5,
        inProgress: 2,
        done: 1,
        issues: [],
      },
      metadata: {
        collectedAt: Date.now(),
        domain: "board",
        tickNumber: 1,
      },
    },
  },
  extensions: {},
  snapshotVersion: 1,
});

describe("auto_mode_running end-to-end with orchestrator", () => {
  let bus: InMemoryEventBus;
  let orchestrator: PlanningOrchestrator;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    orchestrator = new PlanningOrchestrator({ dispatcher: { wipLimit: 5 } });
    registerBoardAutoModeRunningGoal(orchestrator.getRegistry());
    orchestrator.install(bus);
  });

  test("auto_mode_running goal dispatches and completes when board domain present", async () => {
    const dispatched: ActionDispatchPayload[] = [];
    const outcomes: ActionOutcomePayload[] = [];

    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg.payload as ActionDispatchPayload);
    });
    bus.subscribe(TOPICS.WORLD_ACTION_OUTCOME, "test", (msg) => {
      outcomes.push(msg.payload as ActionOutcomePayload);
    });

    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "c1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: worldStateWithBoard(),
    });

    await new Promise((r) => setTimeout(r, 50));

    // Goal should have been dispatched
    expect(dispatched.length).toBeGreaterThanOrEqual(1);
    const goalDispatch = dispatched.find((d) => d.goalId === GOAL_ID);
    expect(goalDispatch).toBeDefined();
    expect(goalDispatch?.action.tier).toBe("tier_0");

    // Goal should have succeeded
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
    const goalOutcome = outcomes.find((o) => o.goalId === GOAL_ID);
    expect(goalOutcome?.success).toBe(true);
  });

  test("auto_mode_running is not triggered when board domain is absent", async () => {
    const dispatched: ActionDispatchPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg.payload as ActionDispatchPayload);
    });

    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "c1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: {
        timestamp: Date.now(),
        domains: {},
        extensions: {},
        snapshotVersion: 1,
      },
    });

    await new Promise((r) => setTimeout(r, 20));

    const goalDispatch = dispatched.find((d) => d.goalId === GOAL_ID);
    expect(goalDispatch).toBeUndefined();
  });

  test("auto_mode_running is idempotent when already running", async () => {
    const dispatched: ActionDispatchPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg.payload as ActionDispatchPayload);
    });

    // extensions.planner.auto_mode_running is already set
    const alreadyRunning: WorldState = {
      ...worldStateWithBoard(),
      extensions: { planner: { auto_mode_running: true } },
    };

    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "c1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: alreadyRunning,
    });

    await new Promise((r) => setTimeout(r, 20));

    const goalDispatch = dispatched.find((d) => d.goalId === GOAL_ID);
    expect(goalDispatch).toBeUndefined();
  });

  test("outcome tracker records the auto_mode_running completion", async () => {
    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "c1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: worldStateWithBoard(),
    });

    await new Promise((r) => setTimeout(r, 50));

    const summary = orchestrator.getDispatcher().getOutcomes().summary();
    expect(summary.total).toBeGreaterThanOrEqual(1);
    expect(summary.success).toBeGreaterThanOrEqual(1);
  });
});
