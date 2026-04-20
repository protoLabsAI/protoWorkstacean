import { describe, it, expect, mock } from "bun:test";
import {
  findUnwiredActions,
  validateActionExecutors,
  UnwiredActionsError,
} from "../validate-action-executors.ts";
import { ActionRegistry } from "../action-registry.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import { FunctionExecutor } from "../../executor/executors/function-executor.ts";
import type { Action } from "../types/action.ts";
import type { BusMessage } from "../../../lib/types.ts";

function makeAction(overrides: Partial<Action> & { id: string; goalId: string }): Action {
  return {
    name: overrides.name ?? overrides.id,
    description: overrides.description ?? "",
    tier: overrides.tier ?? "tier_0",
    cost: overrides.cost ?? 0,
    priority: overrides.priority ?? 0,
    preconditions: overrides.preconditions ?? [],
    effects: overrides.effects ?? [],
    meta: overrides.meta ?? {},
    ...overrides,
  };
}

const noopExecutor = new FunctionExecutor(async (req) => ({
  text: "ok",
  isError: false,
  correlationId: req.correlationId,
}));

describe("findUnwiredActions", () => {
  it("returns empty when every action has a registered executor", () => {
    const actions = new ActionRegistry();
    const executors = new ExecutorRegistry();
    actions.register(makeAction({ id: "alert.foo", goalId: "g.foo" }));
    executors.register("alert.foo", noopExecutor);

    expect(findUnwiredActions(actions, executors)).toEqual([]);
  });

  it("flags an action whose id has no executor and no skillHint", () => {
    const actions = new ActionRegistry();
    const executors = new ExecutorRegistry();
    actions.register(makeAction({ id: "alert.unwired", goalId: "g.x" }));

    const unwired = findUnwiredActions(actions, executors);
    expect(unwired.length).toBe(1);
    expect(unwired[0]).toEqual({
      actionId: "alert.unwired",
      skill: "alert.unwired",
      targets: [],
    });
  });

  it("uses skillHint over action.id when present", () => {
    const actions = new ActionRegistry();
    const executors = new ExecutorRegistry();
    actions.register(makeAction({
      id: "action.do_thing",
      goalId: "g.x",
      meta: { skillHint: "real_skill" },
    }));
    executors.register("real_skill", noopExecutor);

    expect(findUnwiredActions(actions, executors)).toEqual([]);
  });

  it("resolves via meta.agentId when set", () => {
    const actions = new ActionRegistry();
    const executors = new ExecutorRegistry();
    actions.register(makeAction({
      id: "action.delegate",
      goalId: "g.x",
      meta: { skillHint: "any_skill", agentId: "ava" },
    }));
    // Register only by agentName, not skill — emulates AgentRuntimePlugin
    executors.register("some_other_skill", noopExecutor, { agentName: "ava" });

    expect(findUnwiredActions(actions, executors)).toEqual([]);
  });

  it("flags action with agentId target when agent has no executor", () => {
    const actions = new ActionRegistry();
    const executors = new ExecutorRegistry();
    actions.register(makeAction({
      id: "action.delegate",
      goalId: "g.x",
      meta: { skillHint: "any_skill", agentId: "missing_agent" },
    }));

    const unwired = findUnwiredActions(actions, executors);
    expect(unwired.length).toBe(1);
    expect(unwired[0].targets).toEqual(["missing_agent"]);
    expect(unwired[0].skill).toBe("any_skill");
  });

  it("collects multiple gaps in one pass", () => {
    const actions = new ActionRegistry();
    const executors = new ExecutorRegistry();
    actions.register(makeAction({ id: "alert.a", goalId: "g.1" }));
    actions.register(makeAction({ id: "alert.b", goalId: "g.2" }));
    actions.register(makeAction({ id: "alert.c", goalId: "g.3" }));
    executors.register("alert.b", noopExecutor); // only b is wired

    const ids = findUnwiredActions(actions, executors).map(u => u.actionId).sort();
    expect(ids).toEqual(["alert.a", "alert.c"]);
  });
});

describe("validateActionExecutors", () => {
  it("returns empty array when fully wired", () => {
    const actions = new ActionRegistry();
    const executors = new ExecutorRegistry();
    actions.register(makeAction({ id: "alert.foo", goalId: "g.foo" }));
    executors.register("alert.foo", noopExecutor);

    expect(validateActionExecutors(actions, executors)).toEqual([]);
  });

  it("throws UnwiredActionsError when throwOnUnwired is true", () => {
    const actions = new ActionRegistry();
    const executors = new ExecutorRegistry();
    actions.register(makeAction({ id: "alert.bad", goalId: "g.x" }));

    expect(() => validateActionExecutors(actions, executors, { throwOnUnwired: true }))
      .toThrow(UnwiredActionsError);
  });

  it("does NOT throw by default — returns the unwired list", () => {
    const actions = new ActionRegistry();
    const executors = new ExecutorRegistry();
    actions.register(makeAction({ id: "alert.bad", goalId: "g.x" }));

    const unwired = validateActionExecutors(actions, executors);
    expect(unwired.length).toBe(1);
    expect(unwired[0].actionId).toBe("alert.bad");
  });

  it("publishes one HIGH-severity Discord alert per unwired action when bus is provided", () => {
    const actions = new ActionRegistry();
    const executors = new ExecutorRegistry();
    actions.register(makeAction({ id: "alert.x", goalId: "g.1" }));
    actions.register(makeAction({ id: "alert.y", goalId: "g.2" }));
    executors.register("alert.x", noopExecutor); // only x is wired

    const published: BusMessage[] = [];
    const bus = {
      subscribe: mock(() => "sub-id"),
      unsubscribe: mock(() => {}),
      publish: mock((_topic: string, msg: BusMessage) => { published.push(msg); }),
      topics: () => [],
    };

    validateActionExecutors(actions, executors, { bus: bus as never });

    const alerts = published.filter(m => m.topic === "message.outbound.discord.alert");
    expect(alerts.length).toBe(1);
    const p = alerts[0]!.payload as Record<string, unknown>;
    expect(p.actionId).toBe("alert.y");
    expect(p.goalId).toBe("platform.skills_unwired");
    const meta = p.meta as Record<string, unknown>;
    expect(meta.severity).toBe("high");
    expect(meta.agentId).toBe("startup-validator");
  });

  it("error message lists every unwired action", () => {
    const actions = new ActionRegistry();
    const executors = new ExecutorRegistry();
    actions.register(makeAction({ id: "alert.a", goalId: "g.1" }));
    actions.register(makeAction({
      id: "action.b",
      goalId: "g.2",
      meta: { skillHint: "real_b", agentId: "missing_agent" },
    }));

    let caught: UnwiredActionsError | null = null;
    try {
      validateActionExecutors(actions, executors, { throwOnUnwired: true });
    } catch (err) {
      caught = err as UnwiredActionsError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.unwired.length).toBe(2);
    expect(caught!.message).toContain("alert.a");
    expect(caught!.message).toContain("action.b");
    expect(caught!.message).toContain("real_b");
    expect(caught!.message).toContain("missing_agent");
  });
});
