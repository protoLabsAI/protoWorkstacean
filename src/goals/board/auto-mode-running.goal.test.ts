import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ActionRegistry } from "../../planner/action-registry.ts";
import { ActionDispatcherPlugin } from "../../plugins/action-dispatcher-plugin.ts";
import { PlannerPluginL0 } from "../../plugins/planner-plugin-l0.ts";
import { TOPICS } from "../../event-bus/topics.ts";
import {
  registerBoardAutoModeRunningGoal,
  boardAutoModeRunningAction,
  GOAL_ID,
} from "./auto-mode-running.goal.ts";
import type { WorldState } from "../../../lib/types/world-state.ts";
import type { ActionDispatchPayload, ActionOutcomePayload } from "../../event-bus/action-events.ts";

const makeWorldState = (overrides: Partial<WorldState> = {}): WorldState => ({
  timestamp: Date.now(),
  domains: {},
  extensions: {},
  snapshotVersion: 1,
  ...overrides,
});

const worldStateWithBoard: WorldState = makeWorldState({
  domains: {
    board: {
      data: {
        projectSlug: "protoWorkstacean",
        openIssues: 3,
        inProgress: 1,
        done: 0,
        issues: [],
        efficiency: 0.25,
        distribution: { feature: 1, defect: 0, risk: 0, debt: 0 },
      },
      metadata: {
        collectedAt: Date.now(),
        domain: "board",
        tickNumber: 1,
      },
    },
  },
});

describe("board.auto_mode_running goal definition", () => {
  test("action has correct goalId and tier", () => {
    expect(boardAutoModeRunningAction.goalId).toBe(GOAL_ID);
    expect(boardAutoModeRunningAction.tier).toBe("tier_0");
    expect(boardAutoModeRunningAction.cost).toBe(0);
  });

  test("action requires board domain to exist", () => {
    const boardPrecondition = boardAutoModeRunningAction.preconditions.find(
      (p) => p.path === "domains.board" && p.operator === "exists"
    );
    expect(boardPrecondition).toBeDefined();
  });

  test("action requires auto_mode_running to not exist", () => {
    const idempotencyCheck = boardAutoModeRunningAction.preconditions.find(
      (p) => p.path === "extensions.planner.auto_mode_running" && p.operator === "not_exists"
    );
    expect(idempotencyCheck).toBeDefined();
  });

  test("action sets auto_mode_running to true", () => {
    const setEffect = boardAutoModeRunningAction.effects.find(
      (e) => e.path === "planner.auto_mode_running" && e.operation === "set" && e.value === true
    );
    expect(setEffect).toBeDefined();
  });

  test("registerBoardAutoModeRunningGoal adds action to registry", () => {
    const registry = new ActionRegistry();
    registerBoardAutoModeRunningGoal(registry);
    expect(registry.get(boardAutoModeRunningAction.id)).toBeDefined();
    expect(registry.getByGoal(GOAL_ID)).toHaveLength(1);
  });
});

describe("board.auto_mode_running end-to-end", () => {
  let bus: InMemoryEventBus;
  let registry: ActionRegistry;
  let planner: PlannerPluginL0;
  let dispatcher: ActionDispatcherPlugin;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    registry = new ActionRegistry();
    registerBoardAutoModeRunningGoal(registry);

    dispatcher = new ActionDispatcherPlugin({ wipLimit: 5 });
    planner = new PlannerPluginL0(registry);

    dispatcher.install(bus);
    planner.install(bus);
  });

  test("goal is NOT triggered when board domain is missing", async () => {
    const dispatched: ActionDispatchPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg.payload as ActionDispatchPayload);
    });

    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "c1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: makeWorldState(),
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(dispatched).toHaveLength(0);
  });

  test("goal is triggered when board domain is present", async () => {
    const dispatched: ActionDispatchPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg.payload as ActionDispatchPayload);
    });

    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "c1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: worldStateWithBoard,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].goalId).toBe(GOAL_ID);
    expect(dispatched[0].actionId).toBe(boardAutoModeRunningAction.id);
  });

  test("goal completes with success outcome", async () => {
    const outcomes: ActionOutcomePayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_OUTCOME, "test", (msg) => {
      outcomes.push(msg.payload as ActionOutcomePayload);
    });

    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "c1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: worldStateWithBoard,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].success).toBe(true);
    expect(outcomes[0].goalId).toBe(GOAL_ID);
  });

  test("goal is idempotent — not re-triggered when already running", async () => {
    const dispatched: ActionDispatchPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg.payload as ActionDispatchPayload);
    });

    // World state already has auto_mode_running set
    const alreadyRunning = makeWorldState({
      ...worldStateWithBoard,
      extensions: { planner: { auto_mode_running: true } },
    });

    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "c1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: alreadyRunning,
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(dispatched).toHaveLength(0);
  });
});
