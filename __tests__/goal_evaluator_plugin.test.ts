import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { InMemoryEventBus } from "../lib/bus.ts";
import { GoalEvaluatorPlugin } from "../src/plugins/goal_evaluator_plugin.ts";
import type { BusMessage } from "../lib/types.ts";
import type { GoalViolatedEventPayload } from "../src/types/events.ts";

const TMP_DIR = join(process.cwd(), "tmp", "test-goal-evaluator-plugin");

function setup() {
  mkdirSync(join(TMP_DIR, "workspace"), { recursive: true });
}

function teardown() {
  if (existsSync(TMP_DIR)) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
}

function writeGoals(goals: string) {
  writeFileSync(join(TMP_DIR, "workspace", "goals.yaml"), goals);
}

describe("GoalEvaluatorPlugin", () => {
  let bus: InMemoryEventBus;
  let plugin: GoalEvaluatorPlugin;

  beforeEach(() => {
    setup();
    bus = new InMemoryEventBus();
  });

  afterEach(() => {
    plugin?.uninstall();
    teardown();
  });

  test("installs and subscribes to world.state.#", () => {
    plugin = new GoalEvaluatorPlugin({ workspaceDir: join(TMP_DIR, "workspace") });
    plugin.install(bus);

    const topics = bus.topics();
    const worldStateTopic = topics.find(t => t.pattern === "world.state.#");
    expect(worldStateTopic).toBeDefined();
  });

  test("diffs state — emits violation event on goal violation", () => {
    writeGoals(`
goals:
  - id: status-must-be-ok
    type: Invariant
    description: Status must be ok
    selector: status
    operator: eq
    expected: "ok"
`);

    plugin = new GoalEvaluatorPlugin({ workspaceDir: join(TMP_DIR, "workspace") });
    plugin.install(bus);

    const violationEvents: BusMessage[] = [];
    bus.subscribe("world.goal.violated", "test", msg => {
      violationEvents.push(msg);
    });

    bus.publish("world.state.update", {
      id: "1",
      correlationId: "1",
      topic: "world.state.update",
      timestamp: Date.now(),
      payload: { status: "degraded" },
    });

    expect(violationEvents).toHaveLength(1);
    const payload = violationEvents[0].payload as GoalViolatedEventPayload;
    expect(payload.type).toBe("world.goal.violated");
    expect(payload.violation.goalId).toBe("status-must-be-ok");
  });

  test("emits violation event for each violated goal", () => {
    writeGoals(`
goals:
  - id: goal-1
    type: Invariant
    description: Goal 1
    selector: a
    operator: truthy
  - id: goal-2
    type: Threshold
    description: Goal 2
    selector: cpu
    max: 80
`);

    plugin = new GoalEvaluatorPlugin({ workspaceDir: join(TMP_DIR, "workspace") });
    plugin.install(bus);

    const violationEvents: BusMessage[] = [];
    bus.subscribe("world.goal.violated", "test", msg => {
      violationEvents.push(msg);
    });

    bus.publish("world.state.update", {
      id: "2",
      correlationId: "2",
      topic: "world.state.update",
      timestamp: Date.now(),
      payload: { a: null, cpu: 95 },
    });

    expect(violationEvents).toHaveLength(2);
  });

  test("evaluates Invariant goal — no violation when goal is satisfied", () => {
    writeGoals(`
goals:
  - id: status-ok
    type: Invariant
    description: Status must be ok
    selector: status
    operator: eq
    expected: "ok"
`);

    plugin = new GoalEvaluatorPlugin({ workspaceDir: join(TMP_DIR, "workspace") });
    plugin.install(bus);

    const violationEvents: BusMessage[] = [];
    bus.subscribe("world.goal.violated", "test", msg => {
      violationEvents.push(msg);
    });

    bus.publish("world.state.update", {
      id: "3",
      correlationId: "3",
      topic: "world.state.update",
      timestamp: Date.now(),
      payload: { status: "ok" },
    });

    expect(violationEvents).toHaveLength(0);
  });

  test("emits violation event with correct payload structure", () => {
    writeGoals(`
goals:
  - id: cpu-ok
    type: Threshold
    description: CPU below 80
    severity: high
    selector: metrics.cpu
    max: 80
`);

    plugin = new GoalEvaluatorPlugin({ workspaceDir: join(TMP_DIR, "workspace") });
    plugin.install(bus);

    let violationMsg: BusMessage | null = null;
    bus.subscribe("world.goal.violated", "test", msg => {
      violationMsg = msg;
    });

    bus.publish("world.state.update", {
      id: "4",
      correlationId: "4",
      topic: "world.state.update",
      timestamp: Date.now(),
      payload: { metrics: { cpu: 92 } },
    });

    expect(violationMsg).not.toBeNull();
    const payload = violationMsg!.payload as GoalViolatedEventPayload;
    expect(payload.violation.goalId).toBe("cpu-ok");
    expect(payload.violation.goalType).toBe("Threshold");
    expect(payload.violation.severity).toBe("high");
    expect(payload.violation.actual).toBe(92);
  });

  test("evaluateState returns violations directly", () => {
    writeGoals(`
goals:
  - id: status-check
    type: Invariant
    description: Status must be active
    selector: status
    operator: eq
    expected: "active"
`);

    plugin = new GoalEvaluatorPlugin({ workspaceDir: join(TMP_DIR, "workspace") });
    plugin.install(bus);

    const violations = plugin.evaluateState({ status: "inactive" });
    expect(violations).toHaveLength(1);
    expect(violations[0].goalId).toBe("status-check");

    const noViolations = plugin.evaluateState({ status: "active" });
    expect(noViolations).toHaveLength(0);
  });

  test("uninstalls cleanly and stops receiving events", () => {
    writeGoals(`
goals:
  - id: always-violated
    type: Invariant
    description: Always violated
    selector: missing
    operator: truthy
`);

    plugin = new GoalEvaluatorPlugin({ workspaceDir: join(TMP_DIR, "workspace") });
    plugin.install(bus);
    plugin.uninstall();

    const violationEvents: BusMessage[] = [];
    bus.subscribe("world.goal.violated", "test", msg => {
      violationEvents.push(msg);
    });

    bus.publish("world.state.update", {
      id: "5",
      correlationId: "5",
      topic: "world.state.update",
      timestamp: Date.now(),
      payload: {},
    });

    expect(violationEvents).toHaveLength(0);
  });
});
