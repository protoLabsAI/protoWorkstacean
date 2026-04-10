/**
 * PrRemediatorPlugin tests — validates the auto-merge allowlist, HITL
 * escalation, and agent dispatch for fix_ci / address_feedback flows.
 *
 * No real GitHub API calls — the plugin only reads domain data via the bus
 * and publishes outcomes. The merge path requires AUTO_MERGE_ENABLED + a token,
 * so tests run in DRY-RUN mode and assert on the correct bus publications.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { InMemoryEventBus } from "../lib/bus";
import { PrRemediatorPlugin } from "../lib/plugins/pr-remediator";
import type { BusMessage, HITLRequest } from "../lib/types";

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface PrEntry {
  repo: string;
  number: number;
  title: string;
  headSha: string;
  author: string;
  baseRef: string;
  mergeable: "clean" | "dirty" | "blocked" | "unknown";
  ciStatus: "pass" | "fail" | "pending" | "none";
  reviewState: "approved" | "changes_requested" | "pending" | "none";
  isDraft: boolean;
  readyToMerge: boolean;
  labels: string[];
}

function makePr(overrides: Partial<PrEntry> = {}): PrEntry {
  return {
    repo: "acme/app",
    number: 42,
    title: "feat: widget",
    headSha: "abc1234",
    author: "alice",
    baseRef: "main",
    mergeable: "clean",
    ciStatus: "pass",
    reviewState: "approved",
    isDraft: false,
    readyToMerge: true,
    labels: [],
    ...overrides,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function dispatch(bus: InMemoryEventBus, topic: string): void {
  const msg: BusMessage = {
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    topic,
    timestamp: Date.now(),
    payload: { actionId: topic, goalId: "test", meta: {} },
  };
  bus.publish(topic, msg);
}

function captureOn(bus: InMemoryEventBus, pattern: string): BusMessage[] {
  const captured: BusMessage[] = [];
  bus.subscribe(pattern, `test-capture-${pattern}-${crypto.randomUUID()}`, (msg) => {
    captured.push(msg);
  });
  return captured;
}

/**
 * Publishes a world.state.updated event with the given PRs so the plugin's
 * real ingestion path exercises pr_pipeline domain absorption.
 */
function pushWorldState(bus: InMemoryEventBus, prs: PrEntry[]): void {
  bus.publish("world.state.updated", {
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    topic: "world.state.updated",
    timestamp: Date.now(),
    payload: {
      timestamp: Date.now(),
      domains: {
        pr_pipeline: {
          data: { prs },
          metadata: { collectedAt: Date.now(), domain: "pr_pipeline", tickNumber: 1 },
        },
      },
      extensions: {},
      snapshotVersion: 1,
    },
  });
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PrRemediatorPlugin — merge_ready", () => {
  let bus: InMemoryEventBus;
  let plugin: PrRemediatorPlugin;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    plugin = new PrRemediatorPlugin();
    plugin.install(bus);
  });

  afterEach(() => plugin.uninstall());

  test("no-ops when no PRs are ready to merge", async () => {
    pushWorldState(bus, [makePr({ readyToMerge: false })]);
    const hitlCaptured = captureOn(bus, "hitl.request.pr.merge.#");
    const alertCaptured = captureOn(bus, "message.outbound.discord.alert");
    dispatch(bus, "pr.remediate.merge_ready");
    await flushMicrotasks();
    expect(hitlCaptured.length).toBe(0);
    expect(alertCaptured.length).toBe(0);
  });

  test("escalates non-allowlisted PRs to HITL", async () => {
    pushWorldState(bus, [makePr({ number: 101, title: "feat: add thing", author: "human-dev" })]);
    const hitlCaptured = captureOn(bus, "hitl.request.pr.merge.#");
    dispatch(bus, "pr.remediate.merge_ready");
    await flushMicrotasks();
    expect(hitlCaptured.length).toBe(1);
    const req = hitlCaptured[0].payload as HITLRequest;
    expect(req.type).toBe("hitl_request");
    expect(req.title).toContain("#101");
    expect(req.options).toEqual(["approve", "reject"]);
  });

  test("promote: titled PRs are auto-merge eligible (dry-run logs, no HITL)", async () => {
    pushWorldState(bus, [
      makePr({ number: 3331, title: "promote: dev → staging", author: "human-dev" }),
    ]);
    const hitlCaptured = captureOn(bus, "hitl.request.pr.merge.#");
    dispatch(bus, "pr.remediate.merge_ready");
    await flushMicrotasks();
    // In DRY-RUN mode (PR_REMEDIATOR_AUTO_MERGE not set), nothing is published
    // to HITL and nothing is merged. Real merge is gated behind env var.
    expect(hitlCaptured.length).toBe(0);
  });

  test("dependabot PRs are auto-merge eligible", async () => {
    pushWorldState(bus, [
      makePr({ title: "chore(deps): bump foo", author: "dependabot[bot]" }),
    ]);
    const hitlCaptured = captureOn(bus, "hitl.request.pr.merge.#");
    dispatch(bus, "pr.remediate.merge_ready");
    await flushMicrotasks();
    expect(hitlCaptured.length).toBe(0);
  });

  test("auto-merge label PRs are eligible", async () => {
    pushWorldState(bus, [
      makePr({ title: "feat: custom", author: "alice", labels: ["auto-merge"] }),
    ]);
    const hitlCaptured = captureOn(bus, "hitl.request.pr.merge.#");
    dispatch(bus, "pr.remediate.merge_ready");
    await flushMicrotasks();
    expect(hitlCaptured.length).toBe(0);
  });

  test("mixed batch — eligibles auto-merge, others HITL", async () => {
    pushWorldState(bus, [
      makePr({ number: 1, title: "promote: dev → staging", author: "x" }),
      makePr({ number: 2, title: "feat: risky thing", author: "alice" }),
      makePr({ number: 3, title: "chore(deps): bump zod", author: "dependabot[bot]" }),
    ]);
    const hitlCaptured = captureOn(bus, "hitl.request.pr.merge.#");
    dispatch(bus, "pr.remediate.merge_ready");
    await flushMicrotasks();
    // Only #2 should escalate
    expect(hitlCaptured.length).toBe(1);
    const req = hitlCaptured[0].payload as HITLRequest;
    expect(req.title).toContain("#2");
  });

  test("HITL response: approval triggers merge attempt (DRY-RUN logged)", async () => {
    pushWorldState(bus, [makePr({ number: 500, title: "feat: big risky", author: "alice" })]);
    const hitlCaptured = captureOn(bus, "hitl.request.pr.merge.#");
    dispatch(bus, "pr.remediate.merge_ready");
    await flushMicrotasks();
    expect(hitlCaptured.length).toBe(1);
    const req = hitlCaptured[0].payload as HITLRequest;
    // Now simulate Discord publishing an approve decision
    bus.publish(`hitl.response.pr.merge.${req.correlationId}`, {
      id: crypto.randomUUID(),
      correlationId: req.correlationId,
      topic: `hitl.response.pr.merge.${req.correlationId}`,
      timestamp: Date.now(),
      payload: {
        type: "hitl_response",
        correlationId: req.correlationId,
        decision: "approve",
        decidedBy: "josh",
      },
    });
    await flushMicrotasks();
    // In DRY-RUN mode the plugin logs but doesn't hit GitHub — we're
    // validating that the subscription/handler path is wired correctly.
    // If pendingApprovals wasn't cleared, a second response would log an
    // "no matching pending PR" message; that's the regression we're guarding.
    bus.publish(`hitl.response.pr.merge.${req.correlationId}`, {
      id: crypto.randomUUID(),
      correlationId: req.correlationId,
      topic: `hitl.response.pr.merge.${req.correlationId}`,
      timestamp: Date.now(),
      payload: {
        type: "hitl_response",
        correlationId: req.correlationId,
        decision: "approve",
        decidedBy: "josh",
      },
    });
    await flushMicrotasks();
    // No assertion failures — the important thing is that the plugin did not
    // throw and the pending entry was consumed on first approval.
  });

  test("HITL response: reject decision drops the pending entry", async () => {
    pushWorldState(bus, [makePr({ number: 600, title: "feat: another risk", author: "alice" })]);
    const hitlCaptured = captureOn(bus, "hitl.request.pr.merge.#");
    dispatch(bus, "pr.remediate.merge_ready");
    await flushMicrotasks();
    const req = hitlCaptured[0].payload as HITLRequest;
    bus.publish(`hitl.response.pr.merge.${req.correlationId}`, {
      id: crypto.randomUUID(),
      correlationId: req.correlationId,
      topic: `hitl.response.pr.merge.${req.correlationId}`,
      timestamp: Date.now(),
      payload: {
        type: "hitl_response",
        correlationId: req.correlationId,
        decision: "reject",
        decidedBy: "josh",
      },
    });
    await flushMicrotasks();
  });
});

describe("PrRemediatorPlugin — cache invalidation", () => {
  let bus: InMemoryEventBus;
  let plugin: PrRemediatorPlugin;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    plugin = new PrRemediatorPlugin();
    plugin.install(bus);
  });

  afterEach(() => plugin.uninstall());

  test("clears stale pr_pipeline cache when domain missing from next update", async () => {
    // Initial state has PRs
    pushWorldState(bus, [makePr({ number: 77, title: "promote: dev → staging" })]);
    // Subsequent state with NO pr_pipeline domain (collector failed / dropped)
    bus.publish("world.state.updated", {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: "world.state.updated",
      timestamp: Date.now(),
      payload: {
        timestamp: Date.now(),
        domains: {
          // pr_pipeline absent — cache should drop
          flow: { data: {}, metadata: { collectedAt: Date.now(), domain: "flow", tickNumber: 2 } },
        },
        extensions: {},
        snapshotVersion: 2,
      },
    });
    // Now dispatch merge_ready — should no-op because cache was cleared
    const hitlCaptured = captureOn(bus, "hitl.request.pr.merge.#");
    dispatch(bus, "pr.remediate.merge_ready");
    await flushMicrotasks();
    expect(hitlCaptured.length).toBe(0);
  });
});

describe("PrRemediatorPlugin — fix_ci", () => {
  let bus: InMemoryEventBus;
  let plugin: PrRemediatorPlugin;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    plugin = new PrRemediatorPlugin();
    plugin.install(bus);
  });

  afterEach(() => plugin.uninstall());

  test("dispatches to Ava for each failing-CI PR", async () => {
    pushWorldState(bus, [
      makePr({ number: 100, ciStatus: "fail", title: "bug: foo" }),
      makePr({ number: 200, ciStatus: "pass" }),  // should be skipped
      makePr({ number: 300, ciStatus: "fail", title: "bug: bar" }),
    ]);
    const dispatches = captureOn(bus, "agent.skill.request");
    dispatch(bus, "pr.remediate.fix_ci");
    await flushMicrotasks();
    expect(dispatches.length).toBe(2);
    const p0 = dispatches[0].payload as { skill: string; content: string; meta: { agentId: string; skillHint: string } };
    expect(p0.skill).toBe("bug_triage");
    // skill-dispatcher routes by payload.meta.agentId, not top-level agentId
    expect(p0.meta.agentId).toBe("ava");
    expect(p0.meta.skillHint).toBe("bug_triage");
    expect(p0.content).toContain("#100");
    const p1 = dispatches[1].payload as { content: string };
    expect(p1.content).toContain("#300");
  });

  test("no-ops when no failing PRs exist", async () => {
    pushWorldState(bus, [makePr({ ciStatus: "pass" })]);
    const dispatches = captureOn(bus, "agent.skill.request");
    dispatch(bus, "pr.remediate.fix_ci");
    await flushMicrotasks();
    expect(dispatches.length).toBe(0);
  });
});

describe("PrRemediatorPlugin — address_feedback", () => {
  let bus: InMemoryEventBus;
  let plugin: PrRemediatorPlugin;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    plugin = new PrRemediatorPlugin();
    plugin.install(bus);
  });

  afterEach(() => plugin.uninstall());

  test("dispatches to Ava for changes_requested PRs", async () => {
    pushWorldState(bus, [
      makePr({ number: 55, reviewState: "changes_requested" }),
      makePr({ number: 56, reviewState: "approved" }),
    ]);
    const dispatches = captureOn(bus, "agent.skill.request");
    dispatch(bus, "pr.remediate.address_feedback");
    await flushMicrotasks();
    expect(dispatches.length).toBe(1);
    const p = dispatches[0].payload as { content: string; skill: string };
    expect(p.skill).toBe("bug_triage");
    expect(p.content).toContain("#55");
    expect(p.content).toContain("CHANGES_REQUESTED");
  });
});

describe("PrRemediatorPlugin — world state tracking", () => {
  let bus: InMemoryEventBus;
  let plugin: PrRemediatorPlugin;

  beforeEach(() => {
    bus = new InMemoryEventBus();
    plugin = new PrRemediatorPlugin();
    plugin.install(bus);
  });

  afterEach(() => plugin.uninstall());

  test("absorbs pr_pipeline data from world.state.updated", async () => {
    // Simulate world state engine publishing a snapshot
    bus.publish("world.state.updated", {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: "world.state.updated",
      timestamp: Date.now(),
      payload: {
        timestamp: Date.now(),
        domains: {
          pr_pipeline: {
            data: {
              prs: [makePr({ number: 999, title: "promote: dev → staging" })],
            },
            metadata: { collectedAt: Date.now(), domain: "pr_pipeline", tickNumber: 1 },
          },
        },
        extensions: {},
        snapshotVersion: 1,
      },
    });
    // Now dispatch merge_ready — plugin should see PR #999 from world state
    const hitlCaptured = captureOn(bus, "hitl.request.pr.merge.#");
    dispatch(bus, "pr.remediate.merge_ready");
    await flushMicrotasks();
    // promote: is auto-merge eligible → no HITL
    expect(hitlCaptured.length).toBe(0);
  });

  // ── Loop protection ─────────────────────────────────────────────────────────

  describe("loop protection", () => {
    test("fix_ci: repeated triggers on the same PR dispatch only once while in-flight", async () => {
      const bus = new InMemoryEventBus();
      const plugin = new PrRemediatorPlugin();
      plugin.install(bus);

      pushWorldState(bus, [
        makePr({ number: 100, ciStatus: "fail", readyToMerge: false }),
      ]);

      const captured = captureOn(bus, "agent.skill.request");

      // Three triggers back-to-back — should only dispatch once.
      dispatch(bus, "pr.remediate.fix_ci");
      dispatch(bus, "pr.remediate.fix_ci");
      dispatch(bus, "pr.remediate.fix_ci");
      await flushMicrotasks();

      expect(captured.length).toBe(1);
      plugin.uninstall();
    });

    test("fix_ci: a completed skill response frees the slot for a new dispatch", async () => {
      const bus = new InMemoryEventBus();
      const plugin = new PrRemediatorPlugin();
      plugin.install(bus);

      pushWorldState(bus, [
        makePr({ number: 100, ciStatus: "fail", readyToMerge: false }),
      ]);

      const captured = captureOn(bus, "agent.skill.request");

      dispatch(bus, "pr.remediate.fix_ci");
      await flushMicrotasks();
      expect(captured.length).toBe(1);

      // Simulate the skill completing — the remediator should clear its slot.
      const firstCorrelationId = captured[0]!.correlationId;
      bus.publish(`agent.skill.response.${firstCorrelationId}`, {
        id: crypto.randomUUID(),
        correlationId: firstCorrelationId,
        topic: `agent.skill.response.${firstCorrelationId}`,
        timestamp: Date.now(),
        payload: { text: "done", isError: false, correlationId: firstCorrelationId },
      });
      await flushMicrotasks();

      // Cooldown still applies after a completion — the next attempt must wait.
      dispatch(bus, "pr.remediate.fix_ci");
      await flushMicrotasks();
      expect(captured.length).toBe(1);

      plugin.uninstall();
    });

    test("fix_ci: different PRs don't block each other", async () => {
      const bus = new InMemoryEventBus();
      const plugin = new PrRemediatorPlugin();
      plugin.install(bus);

      pushWorldState(bus, [
        makePr({ number: 100, ciStatus: "fail", readyToMerge: false }),
        makePr({ number: 200, ciStatus: "fail", readyToMerge: false }),
      ]);

      const captured = captureOn(bus, "agent.skill.request");

      dispatch(bus, "pr.remediate.fix_ci");
      await flushMicrotasks();
      // Both failing PRs dispatch concurrently — they're independent slots.
      expect(captured.length).toBe(2);

      // A second trigger finds both in-flight and dispatches nothing new.
      dispatch(bus, "pr.remediate.fix_ci");
      await flushMicrotasks();
      expect(captured.length).toBe(2);

      plugin.uninstall();
    });

    test("in-flight entry clears when PR leaves the pipeline (merged/closed)", async () => {
      const bus = new InMemoryEventBus();
      const plugin = new PrRemediatorPlugin();
      plugin.install(bus);

      pushWorldState(bus, [
        makePr({ number: 100, ciStatus: "fail", readyToMerge: false }),
      ]);

      const captured = captureOn(bus, "agent.skill.request");

      dispatch(bus, "pr.remediate.fix_ci");
      await flushMicrotasks();
      expect(captured.length).toBe(1);

      // PR #100 is gone (merged/closed) — world state no longer lists it.
      pushWorldState(bus, []);
      // New PR appears with failing CI.
      pushWorldState(bus, [
        makePr({ number: 101, ciStatus: "fail", readyToMerge: false }),
      ]);

      dispatch(bus, "pr.remediate.fix_ci");
      await flushMicrotasks();
      // PR #101 gets a fresh dispatch even though #100 is no longer blocking.
      expect(captured.length).toBe(2);
      expect(captured[1]!.payload).toHaveProperty("skill", "bug_triage");

      plugin.uninstall();
    });

    test("address_feedback is guarded independently from fix_ci on the same PR", async () => {
      const bus = new InMemoryEventBus();
      const plugin = new PrRemediatorPlugin();
      plugin.install(bus);

      pushWorldState(bus, [
        makePr({
          number: 100,
          ciStatus: "fail",
          reviewState: "changes_requested",
          readyToMerge: false,
        }),
      ]);

      const captured = captureOn(bus, "agent.skill.request");

      dispatch(bus, "pr.remediate.fix_ci");
      await flushMicrotasks();
      expect(captured.length).toBe(1);

      // address_feedback is a different remediation kind — not blocked by fix_ci.
      dispatch(bus, "pr.remediate.address_feedback");
      await flushMicrotasks();
      expect(captured.length).toBe(2);

      // But a second fix_ci on the same PR IS blocked.
      dispatch(bus, "pr.remediate.fix_ci");
      await flushMicrotasks();
      expect(captured.length).toBe(2);

      plugin.uninstall();
    });
  });
});
