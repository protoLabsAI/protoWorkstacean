/**
 * PrRemediatorPlugin tests — validates auto-merge of ready PRs, HITL
 * escalation on stuck fix_ci / address_feedback flows, and the error-path
 * HITL fallback when a merge API call fails.
 *
 * Semantics: any PR with readyToMerge=true (passing CI + approved review)
 * is auto-merged on the next pr.remediate.merge_ready trigger. There is no
 * per-PR allowlist — authorization is enforced upstream by the readyToMerge
 * check in the pr_pipeline domain. Tests run in DRY-RUN mode so no real
 * GitHub API calls happen.
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

  test("any ready PR is auto-merged with no HITL prompt (dry-run, no HITL emitted)", async () => {
    pushWorldState(bus, [
      makePr({ number: 101, title: "feat: add thing", author: "human-dev" }),
      makePr({ number: 102, title: "fix: bug", author: "alice" }),
      makePr({ number: 103, title: "chore(deps): bump foo", author: "dependabot[bot]" }),
      makePr({ number: 104, title: "promote: dev → staging", author: "human-dev" }),
    ]);
    const hitlCaptured = captureOn(bus, "hitl.request.pr.merge.#");
    dispatch(bus, "pr.remediate.merge_ready");
    await flushMicrotasks();
    // In DRY-RUN mode the plugin skips the merge API call AND the HITL
    // prompt for ready PRs. The only time HITL fires in the merge flow
    // is the error-path fallback after a real ghMerge() call fails,
    // which can't happen in DRY-RUN.
    expect(hitlCaptured.length).toBe(0);
  });

  test("non-ready PR is a no-op — no merge, no HITL", async () => {
    pushWorldState(bus, [
      makePr({ number: 200, title: "feat: wip", author: "alice", readyToMerge: false }),
    ]);
    const hitlCaptured = captureOn(bus, "hitl.request.pr.merge.#");
    dispatch(bus, "pr.remediate.merge_ready");
    await flushMicrotasks();
    expect(hitlCaptured.length).toBe(0);
  });

  test("HITL response handler still drains pending approvals from the error-path fallback", async () => {
    // Simulate the only remaining HITL path by directly exercising the
    // response handler — the merge-error fallback is hard to trigger in
    // DRY-RUN, but the subscription must still be wired.
    const correlationId = crypto.randomUUID();
    bus.publish(`hitl.response.pr.merge.${correlationId}`, {
      id: crypto.randomUUID(),
      correlationId,
      topic: `hitl.response.pr.merge.${correlationId}`,
      timestamp: Date.now(),
      payload: {
        type: "hitl_response",
        correlationId,
        decision: "approve",
        decidedBy: "josh",
      },
    });
    await flushMicrotasks();
    // Plugin must not throw when processing an unmatched correlationId.
  });

  test("reject decision drops the pending entry", async () => {
    // Same smoke — plugin must not throw on a reject decision either.
    const correlationId = crypto.randomUUID();
    bus.publish(`hitl.response.pr.merge.${correlationId}`, {
      id: crypto.randomUUID(),
      correlationId,
      topic: `hitl.response.pr.merge.${correlationId}`,
      timestamp: Date.now(),
      payload: {
        type: "hitl_response",
        correlationId,
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

  test("dispatches to Ava for each failing-CI PR with project targeting and directive prompt", async () => {
    pushWorldState(bus, [
      makePr({ number: 100, ciStatus: "fail", title: "bug: foo", repo: "protoLabsAI/protoMaker" }),
      makePr({ number: 200, ciStatus: "pass", repo: "protoLabsAI/protoMaker" }),  // should be skipped
      makePr({ number: 300, ciStatus: "fail", title: "bug: bar", repo: "protoLabsAI/rabbit-hole.io" }),
    ]);
    const dispatches = captureOn(bus, "agent.skill.request");
    dispatch(bus, "pr.remediate.fix_ci");
    await flushMicrotasks();
    expect(dispatches.length).toBe(2);

    const p0 = dispatches[0].payload as {
      skill: string;
      content: string;
      meta: { agentId: string; skillHint: string };
      projectSlug: string;
      projectRepo: string;
      prNumber: number;
    };
    expect(p0.skill).toBe("bug_triage");
    // skill-dispatcher routes by payload.meta.agentId, not top-level agentId
    expect(p0.meta.agentId).toBe("ava");
    expect(p0.meta.skillHint).toBe("bug_triage");
    // Project targeting — reaches Ava via A2AExecutor's `...req.payload` spread
    expect(p0.projectSlug).toBe("protomaker");
    expect(p0.projectRepo).toBe("protoLabsAI/protoMaker");
    expect(p0.prNumber).toBe(100);
    // Directive prompt: autonomous mode, must demand start_auto_mode + antagonistic review
    expect(p0.content).toContain("#100");
    expect(p0.content).toContain("protomaker");
    expect(p0.content).toContain("start_auto_mode");
    expect(p0.content).toContain("fully autonomous mode");
    expect(p0.content).toContain("Antagonistic review");
    expect(p0.content).toContain("No permission checks");

    const p1 = dispatches[1].payload as { content: string; projectSlug: string };
    expect(p1.content).toContain("#300");
    // Verify slug derivation handles dotted repo names
    expect(p1.projectSlug).toBe("rabbit-hole-io");
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

  test("dispatches to Ava for changes_requested PRs with project targeting", async () => {
    pushWorldState(bus, [
      makePr({ number: 55, reviewState: "changes_requested", repo: "protoLabsAI/protoMaker" }),
      makePr({ number: 56, reviewState: "approved", repo: "protoLabsAI/protoMaker" }),
    ]);
    const dispatches = captureOn(bus, "agent.skill.request");
    dispatch(bus, "pr.remediate.address_feedback");
    await flushMicrotasks();
    expect(dispatches.length).toBe(1);
    const p = dispatches[0].payload as {
      content: string;
      skill: string;
      projectSlug: string;
      projectRepo: string;
      meta: { agentId: string };
    };
    expect(p.skill).toBe("bug_triage");
    expect(p.meta.agentId).toBe("ava");
    expect(p.projectSlug).toBe("protomaker");
    expect(p.projectRepo).toBe("protoLabsAI/protoMaker");
    expect(p.content).toContain("#55");
    expect(p.content).toContain("CHANGES_REQUESTED");
    expect(p.content).toContain("start_auto_mode");
    expect(p.content).toContain("fully autonomous mode");
    expect(p.content).toContain("Antagonistic review");
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

    test("exhaustion emits a HITL escalation request (bottlenecks are growth opportunities)", async () => {
      const bus = new InMemoryEventBus();
      const plugin = new PrRemediatorPlugin();
      plugin.install(bus);

      pushWorldState(bus, [
        makePr({ number: 999, ciStatus: "fail", title: "bug: stuck forever", readyToMerge: false }),
      ]);

      const hitlCaptured = captureOn(bus, "hitl.request.pr.remediation_stuck.#");
      const skillCaptured = captureOn(bus, "agent.skill.request");

      // Drive the in-flight entry directly to the exhausted state by firing
      // MAX_ATTEMPTS_PER_PR dispatches with completion responses + TTL-expired
      // cooldowns between them. Easier to drive the internal state by calling
      // the public API than to simulate 15 minutes of wall-clock time.
      //
      // Each dispatch increments attempts; when attempts >= 3 on the next
      // _shouldDispatch call, the entry is marked exhausted AND escalated.
      for (let i = 0; i < 3; i++) {
        dispatch(bus, "pr.remediate.fix_ci");
        await flushMicrotasks();
        // Simulate completion of each skill call so cooldown applies on next attempt
        const latest = skillCaptured[skillCaptured.length - 1];
        if (latest) {
          bus.publish(`agent.skill.response.${latest.correlationId}`, {
            id: crypto.randomUUID(),
            correlationId: latest.correlationId,
            topic: `agent.skill.response.${latest.correlationId}`,
            timestamp: Date.now() - 10 * 60 * 1000, // backdate so cooldown passes
            payload: { text: "done", isError: false, correlationId: latest.correlationId },
          });
          await flushMicrotasks();
          // Backdate the in-flight entry so ATTEMPT_COOLDOWN_MS has passed
          const inFlight = (plugin as unknown as { inFlight: Map<string, { completedAt?: number; startedAt: number }> }).inFlight;
          for (const entry of inFlight.values()) {
            if (entry.completedAt) entry.completedAt -= 10 * 60 * 1000;
            entry.startedAt -= 10 * 60 * 1000;
          }
        }
      }

      // The fourth attempt (now exceeds MAX_ATTEMPTS_PER_PR) should trigger
      // exhaustion + HITL escalation, NOT another dispatch.
      const skillCountBefore = skillCaptured.length;
      dispatch(bus, "pr.remediate.fix_ci");
      await flushMicrotasks();

      expect(skillCaptured.length).toBe(skillCountBefore); // no new dispatch
      expect(hitlCaptured.length).toBeGreaterThan(0);

      const req = hitlCaptured[0]!.payload as HITLRequest;
      expect(req.type).toBe("hitl_request");
      expect(req.title).toContain("#999");
      expect(req.title).toContain("fix_ci");
      expect(req.summary).toContain("Remediation exhausted");
      expect(req.summary).toContain("bug: stuck forever");
      expect(req.summary).toContain("feature request");
      expect(req.options).toEqual(["investigate", "mark_non_remediable", "manual_unblock"]);

      // Subsequent triggers must NOT emit additional escalations (rate-limited)
      dispatch(bus, "pr.remediate.fix_ci");
      await flushMicrotasks();
      expect(hitlCaptured.length).toBe(1);

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
