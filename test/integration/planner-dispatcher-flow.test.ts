/**
 * Integration test: pattern match → action dispatch → state update → outcome feedback.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../lib/bus.ts";
import { PlanningOrchestrator } from "../../src/planner/planning-orchestrator.ts";
import { TOPICS } from "../../src/event-bus/topics.ts";
import type { ActionDispatchPayload } from "../../src/event-bus/action-events.ts";
import type { AutonomousOutcomePayload } from "../../src/event-bus/payloads.ts";
import type { WorldState } from "../../lib/types/world-state.ts";
import type { Action } from "../../src/planner/types/action.ts";

const makeWorldState = (overrides: Partial<WorldState> = {}): WorldState => ({
  timestamp: Date.now(),
  domains: {},
  extensions: {},
  snapshotVersion: 1,
  ...overrides,
});

const makeAction = (overrides: Partial<Action> = {}): Action => ({
  id: "test-action",
  name: "Test Action",
  description: "Integration test action",
  goalId: "test-goal",
  tier: "tier_0",
  preconditions: [],
  effects: [{ path: "planner.test_ran", operation: "set", value: true }],
  cost: 0,
  priority: 0,
  meta: {},
  ...overrides,
});

describe("Planner → Dispatcher integration flow", () => {
  let bus: InMemoryEventBus;
  let orchestrator: PlanningOrchestrator;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    orchestrator = new PlanningOrchestrator({ dispatcher: { wipLimit: 5 } });
    orchestrator.install(bus);
  });

  test("full flow: world state update → dispatch → outcome", async () => {
    const action = makeAction();
    orchestrator.getRegistry().register(action);

    const dispatched: ActionDispatchPayload[] = [];
    const outcomes: AutonomousOutcomePayload[] = [];

    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg.payload as ActionDispatchPayload);
    });
    bus.subscribe("autonomous.outcome.goap.test-action", "test", (msg) => {
      outcomes.push(msg.payload as AutonomousOutcomePayload);
    });

    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "c1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: makeWorldState(),
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].actionId).toBe("test-action");
    expect(dispatched[0].optimisticEffectsApplied).toBe(true);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].success).toBe(true);
    expect(outcomes[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  test("actions with unmet preconditions are not dispatched", async () => {
    const action = makeAction({
      preconditions: [{ path: "domains.board.data.inProgress", operator: "gt", value: 5 }],
    });
    orchestrator.getRegistry().register(action);

    const dispatched: ActionDispatchPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "test", (msg) => {
      dispatched.push(msg.payload as ActionDispatchPayload);
    });

    // inProgress = 2, which is NOT > 5
    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "c1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: makeWorldState({
        domains: {
          board: {
            data: {
              projectSlug: "test",
              openIssues: 2,
              inProgress: 2,
              done: 0,
              issues: [],
            },
            metadata: { collectedAt: Date.now(), domain: "board", tickNumber: 1 },
          },
        },
      }),
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(dispatched).toHaveLength(0);
  });

  test("multi-action chain: two actions for different goals both dispatch", async () => {
    orchestrator.getRegistry().register(makeAction({ id: "a1", goalId: "g1" }));
    orchestrator.getRegistry().register(makeAction({ id: "a2", goalId: "g2" }));

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

    await new Promise((r) => setTimeout(r, 50));

    expect(dispatched).toHaveLength(2);
    const ids = dispatched.map((d) => d.actionId).sort();
    expect(ids).toEqual(["a1", "a2"]);
  });

  test("WIP queue holds excess dispatches beyond limit", async () => {
    // Set WIP limit to 1
    const smallOrchestrator = new PlanningOrchestrator({ dispatcher: { wipLimit: 1 } });
    smallOrchestrator.install(bus);

    // tier_1 actions dispatch to agent.skill.request and stay in-flight until
    // a response arrives — which here never does, so they accumulate against WIP.
    for (let i = 0; i < 3; i++) {
      smallOrchestrator.getRegistry().register(
        makeAction({
          id: `action-${i}`,
          goalId: `goal-${i}`,
          tier: "tier_1",
          meta: { timeout: 30_000 },
        })
      );
    }

    const queueFullEvents: unknown[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_QUEUE_FULL, "test", (msg) => {
      queueFullEvents.push(msg.payload);
    });

    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "c1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: makeWorldState(),
    });

    await new Promise((r) => setTimeout(r, 20));

    // 2 actions should have hit the WIP limit (1 active + 2 queued → 2 queue_full events)
    expect(queueFullEvents.length).toBeGreaterThanOrEqual(1);
    expect(smallOrchestrator.getDispatcher().getQueue().activeCount).toBeLessThanOrEqual(1);
  });
});
