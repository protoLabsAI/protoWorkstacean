import { describe, test, expect, beforeEach } from "bun:test";
import { InMemoryEventBus } from "../../../../lib/bus.ts";
import { CeremonyStateExtension } from "../CeremonyStateExtension.ts";
import type { Ceremony, CeremonyOutcome } from "../../../plugins/CeremonyPlugin.types.ts";
import type { BusMessage } from "../../../../lib/types.ts";

function makeCeremony(id: string): Ceremony {
  return {
    id,
    name: `Ceremony ${id}`,
    schedule: "*/30 * * * *",
    skill: "board_health",
    targets: ["all"],
    enabled: true,
  };
}

function makeOutcome(ceremonyId: string, status: CeremonyOutcome["status"] = "success"): CeremonyOutcome {
  const now = Date.now();
  return {
    runId: crypto.randomUUID(),
    ceremonyId,
    skill: "board_health",
    status,
    duration: 500,
    targets: ["all"],
    startedAt: now - 500,
    completedAt: now,
  };
}

describe("WorldState ceremony extension", () => {
  let bus: InMemoryEventBus;
  let ext: CeremonyStateExtension;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    ext = new CeremonyStateExtension();
    ext.install(bus);
  });

  test("registers ceremonies and initializes idle status", () => {
    ext.registerCeremony(makeCeremony("board.health"));
    const state = ext.getState();
    expect(state.ceremonies["board.health"]).toBeDefined();
    expect(state.status["board.health"]).toBe("idle");
  });

  test("unregisters ceremonies", () => {
    ext.registerCeremony(makeCeremony("board.health"));
    ext.unregisterCeremony("board.health");
    const state = ext.getState();
    expect(state.ceremonies["board.health"]).toBeUndefined();
    expect(state.status["board.health"]).toBeUndefined();
  });

  test("marks ceremony as running", () => {
    ext.registerCeremony(makeCeremony("board.health"));
    ext.markRunning("board.health");
    expect(ext.getState().status["board.health"]).toBe("running");
  });

  test("extensions.ceremonies: updates state on ceremony.*.completed event", () => {
    ext.registerCeremony(makeCeremony("board.health"));
    const outcome = makeOutcome("board.health", "success");

    bus.publish("ceremony.board.health.completed", {
      id: crypto.randomUUID(),
      correlationId: outcome.runId,
      topic: "ceremony.board.health.completed",
      timestamp: Date.now(),
      payload: { type: "ceremony.completed", outcome },
    });

    const state = ext.getState();
    expect(state.status["board.health"]).toBe("idle");
    expect(state.lastRun["board.health"]).toBeDefined();
    expect(state.lastRun["board.health"]!.runId).toBe(outcome.runId);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]!.runId).toBe(outcome.runId);
  });

  test("sets status to failed on failure outcome", () => {
    ext.registerCeremony(makeCeremony("board.health"));
    const outcome = makeOutcome("board.health", "failure");

    bus.publish("ceremony.board.health.completed", {
      id: crypto.randomUUID(),
      correlationId: outcome.runId,
      topic: "ceremony.board.health.completed",
      timestamp: Date.now(),
      payload: { type: "ceremony.completed", outcome },
    });

    expect(ext.getState().status["board.health"]).toBe("failed");
  });

  test("publishes ceremony.state.snapshot after ceremony completes", () => {
    ext.registerCeremony(makeCeremony("board.health"));
    const outcome = makeOutcome("board.health");

    let snapshotPublished = false;
    bus.subscribe("ceremony.state.snapshot", "test", (msg: BusMessage) => {
      const payload = msg.payload as { domain?: string; data?: unknown };
      if (payload?.domain === "extensions.ceremonies") {
        snapshotPublished = true;
      }
    });

    bus.publish("ceremony.board.health.completed", {
      id: crypto.randomUUID(),
      correlationId: outcome.runId,
      topic: "ceremony.board.health.completed",
      timestamp: Date.now(),
      payload: { type: "ceremony.completed", outcome },
    });

    expect(snapshotPublished).toBe(true);
  });

  test("does NOT publish on the world.state.# namespace (issue #424 regression guard)", () => {
    // GoalEvaluatorPlugin subscribes to world.state.#. If ceremony state ever leaks
    // into that namespace, every loaded goal fires a Selector-not-found violation
    // each time a ceremony completes. Lock the namespace boundary here.
    ext.registerCeremony(makeCeremony("board.health"));
    const outcome = makeOutcome("board.health");

    const worldStateMessages: BusMessage[] = [];
    bus.subscribe("world.state.#", "regression-guard", (msg: BusMessage) => {
      worldStateMessages.push(msg);
    });

    bus.publish("ceremony.board.health.completed", {
      id: crypto.randomUUID(),
      correlationId: outcome.runId,
      topic: "ceremony.board.health.completed",
      timestamp: Date.now(),
      payload: { type: "ceremony.completed", outcome },
    });

    expect(worldStateMessages).toHaveLength(0);
  });

  test("history capped at 100 entries", () => {
    ext.registerCeremony(makeCeremony("board.health"));

    for (let i = 0; i < 110; i++) {
      const outcome = makeOutcome("board.health");
      bus.publish("ceremony.board.health.completed", {
        id: crypto.randomUUID(),
        correlationId: outcome.runId,
        topic: "ceremony.board.health.completed",
        timestamp: Date.now(),
        payload: { type: "ceremony.completed", outcome },
      });
    }

    expect(ext.getState().history.length).toBeLessThanOrEqual(100);
  });
});
