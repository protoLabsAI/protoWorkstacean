import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../lib/bus.ts";
import { ActionDispatcherPlugin } from "./action-dispatcher-plugin.ts";
import { TOPICS } from "../event-bus/topics.ts";
import type { ActionDispatchPayload, ActionQueueFullPayload } from "../event-bus/action-events.ts";
import type { AutonomousOutcomePayload } from "../event-bus/payloads.ts";
import type { Action } from "../planner/types/action.ts";
import type { BusMessage } from "../../lib/types.ts";
import type { WorldState } from "../../lib/types/world-state.ts";

const makeWorldState = (): WorldState => ({
  timestamp: Date.now(),
  domains: {},
  extensions: {},
  snapshotVersion: 1,
});

const makeAction = (overrides: Partial<Action> = {}): Action => ({
  id: "test-action",
  name: "Test Action",
  description: "Test",
  goalId: "test-goal",
  // tier_1 by default — exercises the skill-dispatch path. Tier_0 actions
  // are declarative world-state-only and short-circuit to success; tests that
  // need that path override explicitly.
  tier: "tier_1",
  preconditions: [],
  effects: [],
  cost: 0,
  priority: 0,
  meta: {},
  ...overrides,
});

const makeDispatchMsg = (action: Action, correlationId = "corr-1"): BusMessage => ({
  id: crypto.randomUUID(),
  correlationId,
  topic: TOPICS.WORLD_ACTION_DISPATCH,
  timestamp: Date.now(),
  payload: {
    type: "dispatch",
    actionId: action.id,
    goalId: action.goalId,
    action,
    correlationId,
    timestamp: Date.now(),
    optimisticEffectsApplied: false,
  } satisfies ActionDispatchPayload,
});

describe("ActionDispatcherPlugin", () => {
  let bus: InMemoryEventBus;
  let dispatcher: ActionDispatcherPlugin;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    dispatcher = new ActionDispatcherPlugin({ wipLimit: 2 });
    dispatcher.install(bus);
  });

  test("dispatches tier_0 action and publishes outcome", async () => {
    const outcomes: AutonomousOutcomePayload[] = [];
    bus.subscribe("autonomous.outcome.goap.test-action", "test", (msg) => {
      outcomes.push(msg.payload as AutonomousOutcomePayload);
    });

    const action = makeAction({ tier: "tier_0", meta: { fireAndForget: true } });
    bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action));

    // Allow microtasks to process
    await new Promise((r) => setTimeout(r, 10));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].success).toBe(true);
    expect(outcomes[0].actionId).toBe("test-action");
  });

  test("applies optimistic effects on dispatch", async () => {
    const worldState = makeWorldState();
    dispatcher.setWorldState(worldState);

    const action = makeAction({
      effects: [{ path: "planner.auto_mode_running", operation: "set", value: true }],
      meta: { fireAndForget: true },
    });

    bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action));
    await new Promise((r) => setTimeout(r, 10));

    // Outcome should report success
    const outcomes: AutonomousOutcomePayload[] = [];
    // Already dispatched — check queue instead
    expect(dispatcher.getQueue().activeCount).toBe(0);
    expect(dispatcher.getOutcomes().summary().success).toBe(1);
  });

  test("publishes queue_full when WIP limit reached", async () => {
    // WIP limit is 2
    const queueFullEvents: ActionQueueFullPayload[] = [];
    bus.subscribe(TOPICS.WORLD_ACTION_QUEUE_FULL, "test", (msg) => {
      queueFullEvents.push(msg.payload as ActionQueueFullPayload);
    });

    // Dispatch 3 actions without fireAndForget (so they stay in-flight waiting for agent.skill.response.*)
    for (let i = 0; i < 3; i++) {
      const action = makeAction({
        id: `action-${i}`,
        meta: { timeout: 30_000 },
      });
      bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action, `corr-${i}`));
    }

    await new Promise((r) => setTimeout(r, 10));

    expect(queueFullEvents).toHaveLength(1);
    expect(queueFullEvents[0].wipLimit).toBe(2);
  });

  test("records outcome in tracker", async () => {
    const action = makeAction({ meta: { fireAndForget: true } });
    bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action));
    await new Promise((r) => setTimeout(r, 10));

    const summary = dispatcher.getOutcomes().summary();
    expect(summary.total).toBe(1);
    expect(summary.success).toBe(1);
  });

  test("publishes to agent.skill.request with cron source and goap systemActor", async () => {
    const skillRequests: BusMessage[] = [];
    bus.subscribe("agent.skill.request", "test", (msg) => {
      skillRequests.push(msg);
    });

    const action = makeAction({
      id: "skill-action",
      meta: { skillHint: "my_skill", timeout: 30_000 },
    });
    bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action, "corr-skill"));

    await new Promise((r) => setTimeout(r, 10));

    expect(skillRequests).toHaveLength(1);
    const req = skillRequests[0];
    expect(req.source).toEqual({ interface: "cron" });
    expect(req.reply?.topic).toBe("agent.skill.response.corr-skill");
    const payload = req.payload as Record<string, unknown>;
    expect(payload.skill).toBe("my_skill");
    expect((payload.meta as Record<string, unknown>).systemActor).toBe("goap");
  });

  test("uses action.id as skill when skillHint is absent", async () => {
    const skillRequests: BusMessage[] = [];
    bus.subscribe("agent.skill.request", "test", (msg) => {
      skillRequests.push(msg);
    });

    const action = makeAction({
      id: "fallback-action",
      meta: { timeout: 30_000 },
    });
    bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action, "corr-fallback"));

    await new Promise((r) => setTimeout(r, 10));

    expect(skillRequests).toHaveLength(1);
    const payload = skillRequests[0].payload as Record<string, unknown>;
    expect(payload.skill).toBe("fallback-action");
  });

  test("completes action when agent.skill.response.* is received", async () => {
    const outcomes: AutonomousOutcomePayload[] = [];
    bus.subscribe("autonomous.outcome.#", "test", (msg) => {
      outcomes.push(msg.payload as AutonomousOutcomePayload);
    });

    const action = makeAction({
      id: "response-action",
      meta: { skillHint: "my_skill", timeout: 5_000 },
    });
    bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action, "corr-resp"));
    await new Promise((r) => setTimeout(r, 10));

    // Simulate skill response
    bus.publish("agent.skill.response.corr-resp", {
      id: crypto.randomUUID(),
      correlationId: "corr-resp",
      topic: "agent.skill.response.corr-resp",
      timestamp: Date.now(),
      payload: { correlationId: "corr-resp", content: "done" },
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].success).toBe(true);
    expect(outcomes[0].actionId).toBe("response-action");
  });

  test("updates world state on world.state.updated", () => {
    const worldState = makeWorldState();
    bus.publish(TOPICS.WORLD_STATE_UPDATED, {
      id: "1",
      correlationId: "c1",
      topic: TOPICS.WORLD_STATE_UPDATED,
      timestamp: Date.now(),
      payload: worldState,
    });
    // No error = state updated successfully
  });

  // ── meta.cooldownMs — per-action dedup at the dispatcher (issue #437) ──

  describe("per-action cooldown (meta.cooldownMs)", () => {
    test("blocks repeat dispatches of the same action within window", async () => {
      const requests: BusMessage[] = [];
      bus.subscribe(TOPICS.AGENT_SKILL_REQUEST, "spy", (m) => requests.push(m));

      const action = makeAction({
        id: "cooldown-action-A",
        meta: { fireAndForget: true, cooldownMs: 60_000 },
      });

      // Fire 5 dispatches in rapid succession.
      for (let i = 0; i < 5; i++) {
        bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action, `corr-${i}`));
      }
      await new Promise((r) => setTimeout(r, 10));

      // Only the first dispatch should reach the executor; the other 4 are
      // dropped at the dispatcher BEFORE agent.skill.request is published.
      expect(requests).toHaveLength(1);
      expect(dispatcher.getOutcomes().summary().total).toBe(1);
    });

    test("cooldown of action A does not affect action B", async () => {
      const requests: BusMessage[] = [];
      bus.subscribe(TOPICS.AGENT_SKILL_REQUEST, "spy", (m) => requests.push(m));

      const actionA = makeAction({
        id: "cooldown-A",
        meta: { fireAndForget: true, cooldownMs: 60_000 },
      });
      const actionB = makeAction({
        id: "cooldown-B",
        meta: { fireAndForget: true, cooldownMs: 60_000 },
      });

      // Fire A twice and B twice — A's second drop, B's second drop, both
      // independent. Two should reach the executor (one per action id).
      bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(actionA, "a-1"));
      bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(actionB, "b-1"));
      bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(actionA, "a-2"));
      bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(actionB, "b-2"));
      await new Promise((r) => setTimeout(r, 10));

      expect(requests).toHaveLength(2);
      const skills = requests.map((r) => (r.payload as Record<string, unknown>).skill).sort();
      expect(skills).toEqual(["cooldown-A", "cooldown-B"]);
    });

    test("dispatch after window expires is admitted", async () => {
      const requests: BusMessage[] = [];
      bus.subscribe(TOPICS.AGENT_SKILL_REQUEST, "spy", (m) => requests.push(m));

      const action = makeAction({
        id: "cooldown-expire",
        // 1ms cooldown — easy to exceed via setTimeout below.
        meta: { fireAndForget: true, cooldownMs: 1 },
      });

      bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action, "c-1"));
      await new Promise((r) => setTimeout(r, 10));
      expect(requests).toHaveLength(1);

      // Wait past the cooldown window then re-dispatch.
      await new Promise((r) => setTimeout(r, 20));
      bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action, "c-2"));
      await new Promise((r) => setTimeout(r, 10));

      expect(requests).toHaveLength(2);
    });

    test("absent meta.cooldownMs means no cooldown (greenfield default)", async () => {
      const requests: BusMessage[] = [];
      bus.subscribe(TOPICS.AGENT_SKILL_REQUEST, "spy", (m) => requests.push(m));

      const action = makeAction({
        id: "no-cooldown",
        meta: { fireAndForget: true },
      });

      for (let i = 0; i < 3; i++) {
        bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action, `nc-${i}`));
      }
      await new Promise((r) => setTimeout(r, 10));

      // Without cooldownMs there's no throttling — all 3 reach the executor.
      expect(requests).toHaveLength(3);
    });

    test("cooldownMs <= 0 is treated as no cooldown", async () => {
      const requests: BusMessage[] = [];
      bus.subscribe(TOPICS.AGENT_SKILL_REQUEST, "spy", (m) => requests.push(m));

      const action = makeAction({
        id: "zero-cooldown",
        meta: { fireAndForget: true, cooldownMs: 0 },
      });

      for (let i = 0; i < 3; i++) {
        bus.publish(TOPICS.WORLD_ACTION_DISPATCH, makeDispatchMsg(action, `z-${i}`));
      }
      await new Promise((r) => setTimeout(r, 10));

      expect(requests).toHaveLength(3);
    });
  });
});
