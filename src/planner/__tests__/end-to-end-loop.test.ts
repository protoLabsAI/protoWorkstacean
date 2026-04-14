/**
 * End-to-end GOAP loop integration test.
 *
 * Proves the self-improving loop closes:
 *
 *   world.goal.violated
 *     → PlannerPluginL0 selects action
 *     → world.action.dispatch
 *     → ActionDispatcherPlugin runs tier_0 action
 *     → autonomous.outcome.goap.{skill}
 *     → Planner records outcome + sets post-success cooldown
 *     → next violation for same goal is suppressed (cooldown active)
 *
 * If any step is broken, this test fails — making regressions on the
 * feedback machinery loud instead of silent.
 */

import { describe, test, expect } from "bun:test";
import { InMemoryEventBus } from "../../../lib/bus.ts";
import { ActionRegistry } from "../action-registry.ts";
import { PlannerPluginL0 } from "../../plugins/planner-plugin-l0.ts";
import { ActionDispatcherPlugin } from "../../plugins/action-dispatcher-plugin.ts";
import { TOPICS } from "../../event-bus/topics.ts";
import type { Action } from "../types/action.ts";
import type { ActionDispatchPayload } from "../../event-bus/action-events.ts";
import type { AutonomousOutcomePayload } from "../../event-bus/payloads.ts";
import type { GoalViolatedEventPayload } from "../../types/events.ts";

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    id: "restart-workstream",
    name: "Restart Workstream",
    description: "Clear blocked PRs by restarting the CI runner",
    goalId: "ci.no_blocked_prs",
    tier: "tier_0",
    preconditions: [],
    effects: [{ path: "ci.blockedPRs", operation: "set", value: 0 }],
    cost: 0,
    priority: 10,
    meta: { fireAndForget: true },
    ...overrides,
  };
}

function makeViolation(goalId: string, correlationId: string) {
  return {
    id: crypto.randomUUID(),
    correlationId,
    topic: "world.goal.violated",
    timestamp: Date.now(),
    payload: {
      type: "world.goal.violated",
      violation: {
        goalId,
        goalType: "Threshold",
        severity: "high",
        description: "Blocked PRs exceed threshold",
        message: "ci.blockedPRs = 3 > max 0",
        actual: 3,
        expected: 0,
        timestamp: Date.now(),
      },
    } satisfies GoalViolatedEventPayload,
  };
}

describe("GOAP end-to-end feedback loop", () => {
  test("violation → dispatch → outcome → cooldown suppresses re-dispatch", async () => {
    const bus = new InMemoryEventBus();
    const registry = new ActionRegistry();
    registry.upsert(makeAction());

    const planner = new PlannerPluginL0(registry);
    const dispatcher = new ActionDispatcherPlugin({ wipLimit: 5 });
    planner.install(bus);
    dispatcher.install(bus);

    const dispatches: ActionDispatchPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_DISPATCH, "spy", (m) => {
      dispatches.push(m.payload as ActionDispatchPayload);
    });

    const outcomes: AutonomousOutcomePayload[] = [];
    bus.subscribe("autonomous.outcome.goap.restart-workstream", "spy", (m) => {
      outcomes.push(m.payload as AutonomousOutcomePayload);
    });

    // 1. Violate the goal — planner should dispatch.
    bus.publish("world.goal.violated", makeViolation("ci.no_blocked_prs", "corr-1"));
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0].actionId).toBe("restart-workstream");
    expect(dispatches[0].goalId).toBe("ci.no_blocked_prs");

    // 2. tier_0 fireAndForget — dispatcher should have already published
    //    autonomous.outcome.goap.restart-workstream with success=true.
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].success).toBe(true);
    expect(outcomes[0].actionId).toBe("restart-workstream");
    expect(outcomes[0].goalId).toBe("ci.no_blocked_prs");

    // 3. Planner recorded the outcome and set a success cooldown.
    //    Loop detector should have the attempt logged.
    const ld = planner.getLoopDetector();
    expect(ld.getHistory("ci.no_blocked_prs", "restart-workstream")).toHaveLength(1);
    expect(ld.getHistory("ci.no_blocked_prs", "restart-workstream")[0].succeeded).toBe(true);

    // 4. Violate the goal again — cooldown must suppress the re-dispatch.
    //    (Real domain poll hasn't caught up yet; without cooldown we'd re-fire.)
    bus.publish("world.goal.violated", makeViolation("ci.no_blocked_prs", "corr-2"));
    await new Promise((r) => setTimeout(r, 10));

    expect(dispatches).toHaveLength(1); // still 1 — cooldown blocked the re-dispatch
  });

  test("outcome payload carries actionId + goalId so planner can correlate", async () => {
    const bus = new InMemoryEventBus();
    const registry = new ActionRegistry();
    registry.upsert(makeAction({ id: "alt-action", goalId: "alt.goal" }));

    const planner = new PlannerPluginL0(registry);
    const dispatcher = new ActionDispatcherPlugin({ wipLimit: 5 });
    planner.install(bus);
    dispatcher.install(bus);

    const outcomes: AutonomousOutcomePayload[] = [];
    bus.subscribe("autonomous.outcome.#", "spy", (m) => {
      outcomes.push(m.payload as AutonomousOutcomePayload);
    });

    bus.publish("world.goal.violated", makeViolation("alt.goal", "corr-a"));
    await new Promise((r) => setTimeout(r, 10));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].actionId).toBe("alt-action");
    expect(outcomes[0].goalId).toBe("alt.goal");
    // Correlation is what lets the planner's autonomous.outcome.# subscriber
    // drop non-GOAP outcomes (user messages, ceremonies) and only record
    // the ones the planner originated.
    expect(outcomes[0].correlationId).toBeTruthy();
  });
});
