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

  // ── Issue #424 — selector drift / payload-shape regression guards ────────

  test("ignores non-WorldState payloads on world.state.# (issue #424)", () => {
    // Reproduces the original bug: CeremonyStateExtension previously published
    // { domain: "extensions.ceremonies", data: ... } on world.state.snapshot,
    // which matched the goal-evaluator's world.state.# subscription and caused
    // every loaded goal to fire a Selector-not-found violation per ceremony tick.
    writeGoals(`
goals:
  - id: flow.efficiency_healthy
    type: Threshold
    severity: medium
    description: flow ratio >= 0.35
    selector: domains.flow.data.efficiency.ratio
    min: 0.35
  - id: services.discord_connected
    type: Invariant
    severity: high
    description: discord connected
    selector: domains.services.data.discord.connected
    operator: truthy
  - id: agents.registered
    type: Threshold
    severity: high
    description: at least one agent
    selector: domains.agent_health.data.agentCount
    min: 1
`);

    plugin = new GoalEvaluatorPlugin({ workspaceDir: join(TMP_DIR, "workspace") });
    plugin.install(bus);

    const violationEvents: BusMessage[] = [];
    bus.subscribe("world.goal.violated", "test", msg => violationEvents.push(msg));

    // Simulate the exact malformed payload the broken extension was emitting.
    bus.publish("world.state.snapshot", {
      id: "snap-1",
      correlationId: "snap-1",
      topic: "world.state.snapshot",
      timestamp: Date.now(),
      payload: {
        domain: "extensions.ceremonies",
        data: { ceremonies: {}, history: [], status: {}, lastRun: {}, updatedAt: Date.now() },
      },
    });

    // No violations should fire from a malformed payload.
    expect(violationEvents).toHaveLength(0);
  });

  test("each fixed goal evaluates without selector-not-found against a real WorldState (issue #424)", () => {
    writeGoals(`
goals:
  - id: flow.efficiency_healthy
    type: Threshold
    severity: medium
    description: flow ratio >= 0.35
    selector: domains.flow.data.efficiency.ratio
    min: 0.35
  - id: services.discord_connected
    type: Invariant
    severity: high
    description: discord connected
    selector: domains.services.data.discord.connected
    operator: truthy
  - id: agents.registered
    type: Threshold
    severity: high
    description: at least one agent
    selector: domains.agent_health.data.agentCount
    min: 1
`);

    plugin = new GoalEvaluatorPlugin({ workspaceDir: join(TMP_DIR, "workspace") });
    plugin.install(bus);

    const violationEvents: BusMessage[] = [];
    bus.subscribe("world.goal.violated", "test", msg => violationEvents.push(msg));

    // Real WorldState shape from /api/world-state — every selector resolves.
    bus.publish("world.state.updated", {
      id: "ws-1",
      correlationId: "ws-1",
      topic: "world.state.updated",
      timestamp: Date.now(),
      payload: {
        timestamp: Date.now(),
        domains: {
          flow: { data: { efficiency: { ratio: 1 } }, metadata: { collectedAt: Date.now(), domain: "flow", tickNumber: 1 } },
          services: { data: { discord: { connected: true } }, metadata: { collectedAt: Date.now(), domain: "services", tickNumber: 1 } },
          agent_health: { data: { agentCount: 7 }, metadata: { collectedAt: Date.now(), domain: "agent_health", tickNumber: 1 } },
        },
        extensions: {},
        snapshotVersion: 0,
      },
    });

    // None of the three should produce a Selector-not-found violation.
    const notFound = violationEvents.filter(e => {
      const v = (e.payload as GoalViolatedEventPayload).violation;
      return v.message.includes("not found in world state");
    });
    expect(notFound).toHaveLength(0);
  });

  test("startup validator catches an intentionally-broken goal selector", () => {
    // One good goal, one with a selector pointing at a non-existent domain.
    writeGoals(`
goals:
  - id: agents.registered
    type: Threshold
    severity: high
    description: at least one agent
    selector: domains.agent_health.data.agentCount
    min: 1
  - id: bogus.selector
    type: Threshold
    severity: medium
    description: deliberately broken
    selector: domains.does_not_exist.data.someField
    max: 10
`);

    plugin = new GoalEvaluatorPlugin({ workspaceDir: join(TMP_DIR, "workspace") });
    plugin.install(bus);

    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };

    try {
      bus.publish("world.state.updated", {
        id: "ws-2",
        correlationId: "ws-2",
        topic: "world.state.updated",
        timestamp: Date.now(),
        payload: {
          timestamp: Date.now(),
          domains: {
            agent_health: { data: { agentCount: 7 }, metadata: { collectedAt: Date.now(), domain: "agent_health", tickNumber: 1 } },
          },
          extensions: {},
          snapshotVersion: 0,
        },
      });
    } finally {
      console.error = origError;
    }

    const validatorOutput = errors.join("\n");
    expect(validatorOutput).toContain("[goal-evaluator:validator]");
    expect(validatorOutput).toContain("bogus.selector");
    expect(validatorOutput).toContain("domains.does_not_exist.data.someField");
    // The good goal must NOT be flagged.
    expect(validatorOutput).not.toContain("agents.registered");
  });
});
