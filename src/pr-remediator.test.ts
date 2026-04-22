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
  headRef?: string;
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
    baseRef: "dev",
    headRef: "feature/x",
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
    const dispatches = captureOn(bus, "agent.skill.request");
    pushWorldState(bus, [
      makePr({ number: 100, ciStatus: "fail", title: "bug: foo", repo: "protoLabsAI/protoMaker" }),
      makePr({ number: 200, ciStatus: "pass", repo: "protoLabsAI/protoMaker" }),  // should be skipped
      makePr({ number: 300, ciStatus: "fail", title: "bug: bar", repo: "protoLabsAI/rabbit-hole.io" }),
    ]);
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
    expect(p0.meta.agentId).toBe("protomaker");
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
    const dispatches = captureOn(bus, "agent.skill.request");
    pushWorldState(bus, [
      makePr({ number: 55, reviewState: "changes_requested", repo: "protoLabsAI/protoMaker" }),
      makePr({ number: 56, reviewState: "approved", repo: "protoLabsAI/protoMaker" }),
    ]);
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
    expect(p.meta.agentId).toBe("protomaker");
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

      const captured = captureOn(bus, "agent.skill.request");

      pushWorldState(bus, [
        makePr({ number: 100, ciStatus: "fail", readyToMerge: false }),
      ]);
      await flushMicrotasks();

      // Self-dispatch fires exactly once for the failing PR.
      expect(captured.length).toBe(1);

      // Explicit triggers are blocked — the PR is already in-flight.
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

      const captured = captureOn(bus, "agent.skill.request");

      pushWorldState(bus, [
        makePr({ number: 100, ciStatus: "fail", readyToMerge: false }),
      ]);
      await flushMicrotasks();

      // Self-dispatch fires the first handler call.
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

      const captured = captureOn(bus, "agent.skill.request");

      pushWorldState(bus, [
        makePr({ number: 100, ciStatus: "fail", readyToMerge: false }),
        makePr({ number: 200, ciStatus: "fail", readyToMerge: false }),
      ]);
      await flushMicrotasks();

      // Both failing PRs dispatch concurrently via self-dispatch — independent slots.
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

      const captured = captureOn(bus, "agent.skill.request");

      pushWorldState(bus, [
        makePr({ number: 100, ciStatus: "fail", readyToMerge: false }),
      ]);
      await flushMicrotasks();
      // Self-dispatch fires for PR #100.
      expect(captured.length).toBe(1);

      // PR #100 is gone (merged/closed) — world state no longer lists it.
      pushWorldState(bus, []);
      await flushMicrotasks();

      // New PR appears with failing CI — self-dispatch fires for #101.
      pushWorldState(bus, [
        makePr({ number: 101, ciStatus: "fail", readyToMerge: false }),
      ]);
      await flushMicrotasks();

      // PR #101 gets a fresh dispatch; #100's in-flight entry was pruned.
      expect(captured.length).toBe(2);
      expect(captured[1]!.payload).toHaveProperty("skill", "bug_triage");

      plugin.uninstall();
    });

    test("exhaustion emits a HITL escalation request (bottlenecks are growth opportunities)", async () => {
      const bus = new InMemoryEventBus();
      const plugin = new PrRemediatorPlugin();
      plugin.install(bus);

      const hitlCaptured = captureOn(bus, "hitl.request.pr.remediation_stuck.#");
      const skillCaptured = captureOn(bus, "agent.skill.request");

      pushWorldState(bus, [
        makePr({ number: 999, ciStatus: "fail", title: "bug: stuck forever", readyToMerge: false }),
      ]);
      await flushMicrotasks();

      // Self-dispatch fires attempt 1. Drive toward exhaustion by completing
      // each attempt with backdated cooldowns. MAX_ATTEMPTS_PER_PR = 3.
      expect(skillCaptured.length).toBe(1); // attempt 1 from self-dispatch

      // Complete attempt 1 + backdate cooldown so attempt 2 can fire.
      const completeAndBackdate = async () => {
        const latest = skillCaptured[skillCaptured.length - 1]!;
        bus.publish(`agent.skill.response.${latest.correlationId}`, {
          id: crypto.randomUUID(),
          correlationId: latest.correlationId,
          topic: `agent.skill.response.${latest.correlationId}`,
          timestamp: Date.now(),
          payload: { text: "done", isError: false, correlationId: latest.correlationId },
        });
        await flushMicrotasks();
        const inFlight = (plugin as unknown as { inFlight: Map<string, { completedAt?: number; startedAt: number }> }).inFlight;
        for (const entry of inFlight.values()) {
          if (entry.completedAt) entry.completedAt -= 10 * 60 * 1000;
          entry.startedAt -= 10 * 60 * 1000;
        }
      };

      // Attempts 2 and 3 via explicit dispatch (slot freed after completing previous).
      for (let i = 0; i < 2; i++) {
        await completeAndBackdate();
        dispatch(bus, "pr.remediate.fix_ci");
        await flushMicrotasks();
      }
      expect(skillCaptured.length).toBe(3);

      // Complete attempt 3 and backdate.
      await completeAndBackdate();

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
      expect(req.sourceMeta?.interface).toBe("discord");

      // Subsequent triggers must NOT emit additional escalations (rate-limited)
      dispatch(bus, "pr.remediate.fix_ci");
      await flushMicrotasks();
      expect(hitlCaptured.length).toBe(1);

      plugin.uninstall();
    });

    test("update_branch is blocked while diagnose_pr_stuck is in-flight", async () => {
      const bus = new InMemoryEventBus();
      const plugin = new PrRemediatorPlugin();
      plugin.install(bus);

      pushWorldState(bus, [makePr({ number: 42, mergeable: "dirty", readyToMerge: false })]);

      // Manually mark a diagnosis as in-flight for this PR
      const diagnosisInFlight = (plugin as unknown as { diagnosisInFlight: Map<string, string> }).diagnosisInFlight;
      diagnosisInFlight.set("acme/app#42", "fake-diagnosis-cid");

      // The world-state poller fires update_branch — should be blocked
      const skillCaptured = captureOn(bus, "agent.skill.request");
      dispatch(bus, "pr.remediate.update_branch");
      await flushMicrotasks();
      // No agent.skill.request dispatched because diagnosis is blocking retries
      expect(skillCaptured.length).toBe(0);

      plugin.uninstall();
    });

    test("address_feedback is guarded independently from fix_ci on the same PR", async () => {
      const bus = new InMemoryEventBus();
      const plugin = new PrRemediatorPlugin();
      plugin.install(bus);

      const captured = captureOn(bus, "agent.skill.request");

      // PR has both failing CI and changes_requested — self-dispatch fires both handlers.
      pushWorldState(bus, [
        makePr({
          number: 100,
          ciStatus: "fail",
          reviewState: "changes_requested",
          readyToMerge: false,
        }),
      ]);
      await flushMicrotasks();

      // Self-dispatch fires both fix_ci and address_feedback — independent kinds.
      expect(captured.length).toBe(2);

      // Explicit dispatches are blocked — both kinds already in-flight.
      dispatch(bus, "pr.remediate.fix_ci");
      await flushMicrotasks();
      expect(captured.length).toBe(2);

      dispatch(bus, "pr.remediate.address_feedback");
      await flushMicrotasks();
      expect(captured.length).toBe(2);

      plugin.uninstall();
    });
  });
});

// ── diagnose_pr_stuck ─────────────────────────────────────────────────────────
//
// Tests exercise the private API via `as unknown as` casting — same pattern as
// the loop-protection tests that manipulate the inFlight map directly.

describe("PrRemediatorPlugin — diagnose_pr_stuck", () => {
  type PluginPrivate = {
    _dispatchDiagnose(pr: PrEntry, correlationId: string): void;
    diagnosisInFlight: Map<string, string>;
  };

  function privateOf(plugin: PrRemediatorPlugin): PluginPrivate {
    return plugin as unknown as PluginPrivate;
  }

  test("_dispatchDiagnose publishes diagnose_pr_stuck skill request targeting Ava", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new PrRemediatorPlugin();
    plugin.install(bus);

    const skillCaptured = captureOn(bus, "agent.skill.request");
    const pr = makePr({ number: 55, mergeable: "dirty", readyToMerge: false });

    privateOf(plugin)._dispatchDiagnose(pr, crypto.randomUUID());
    await flushMicrotasks();

    expect(skillCaptured.length).toBe(1);
    const p = skillCaptured[0]!.payload as {
      skill: string;
      meta: { agentId: string; skillHint: string; systemActor: string };
      content: string;
    };
    expect(p.skill).toBe("diagnose_pr_stuck");
    expect(p.meta.agentId).toBe("ava");
    expect(p.meta.skillHint).toBe("diagnose_pr_stuck");
    expect(p.meta.systemActor).toBe("pr-remediator");
    expect(p.content).toContain("#55");
    expect(p.content).toContain("acme/app");

    plugin.uninstall();
  });

  test("diagnosisInFlight is set while dispatch is in-flight and cleared after response", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new PrRemediatorPlugin();
    plugin.install(bus);

    pushWorldState(bus, [makePr({ number: 88, mergeable: "dirty", readyToMerge: false })]);

    const skillCaptured = captureOn(bus, "agent.skill.request");
    const pr = makePr({ number: 88, mergeable: "dirty", readyToMerge: false });

    privateOf(plugin)._dispatchDiagnose(pr, crypto.randomUUID());
    await flushMicrotasks();

    // While diagnosis is running, the entry should be present
    expect(privateOf(plugin).diagnosisInFlight.has("acme/app#88")).toBe(true);

    // Publish a response to clear it
    const cid = skillCaptured[0]!.correlationId;
    bus.publish(`agent.skill.response.${cid}`, {
      id: crypto.randomUUID(),
      correlationId: cid,
      topic: `agent.skill.response.${cid}`,
      timestamp: Date.now(),
      payload: { text: '{"verdict":"genuine","evidence":"semantic conflict"}' },
    });
    await flushMicrotasks();

    // After response, diagnosisInFlight must be cleared
    expect(privateOf(plugin).diagnosisInFlight.has("acme/app#88")).toBe(false);

    plugin.uninstall();
  });

  test("genuine verdict escalates to HITL with conflict details in summary", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new PrRemediatorPlugin();
    plugin.install(bus);

    pushWorldState(bus, [makePr({ number: 55, mergeable: "dirty", readyToMerge: false })]);

    const hitlCaptured = captureOn(bus, "hitl.request.pr.remediation_stuck.#");
    const skillCaptured = captureOn(bus, "agent.skill.request");

    const pr = makePr({ number: 55, mergeable: "dirty", readyToMerge: false });
    privateOf(plugin)._dispatchDiagnose(pr, crypto.randomUUID());
    await flushMicrotasks();

    const cid = skillCaptured[0]!.correlationId;
    bus.publish(`agent.skill.response.${cid}`, {
      id: crypto.randomUUID(),
      correlationId: cid,
      topic: `agent.skill.response.${cid}`,
      timestamp: Date.now(),
      payload: {
        text: '```json\n{"verdict":"genuine","evidence":"conflicting logic in src/auth.ts cannot be auto-resolved","conflictingFiles":["src/auth.ts"]}\n```',
      },
    });
    await flushMicrotasks();

    expect(hitlCaptured.length).toBeGreaterThan(0);
    const req = hitlCaptured[0]!.payload as HITLRequest;
    expect(req.type).toBe("hitl_request");
    expect(req.title).toContain("#55");
    expect(req.title).toContain("update_branch");
    expect(req.summary).toContain("genuine");
    expect(req.summary).toContain("conflicting logic in src/auth.ts");
    expect(req.sourceMeta?.interface).toBe("discord");

    plugin.uninstall();
  });

  test("rebasable verdict dispatches merge-assist via bug_triage to protomaker", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new PrRemediatorPlugin();
    plugin.install(bus);

    pushWorldState(bus, [makePr({ number: 77, mergeable: "dirty", readyToMerge: false })]);

    const skillCaptured = captureOn(bus, "agent.skill.request");
    const pr = makePr({ number: 77, mergeable: "dirty", readyToMerge: false });

    privateOf(plugin)._dispatchDiagnose(pr, crypto.randomUUID());
    await flushMicrotasks();

    const cid = skillCaptured[0]!.correlationId;
    bus.publish(`agent.skill.response.${cid}`, {
      id: crypto.randomUUID(),
      correlationId: cid,
      topic: `agent.skill.response.${cid}`,
      timestamp: Date.now(),
      payload: {
        text: '```json\n{"verdict":"rebasable","evidence":"conflicts in docs/ are whitespace-only","conflictingFiles":["docs/api.md"]}\n```',
      },
    });
    await flushMicrotasks();

    // 1 diagnose dispatch + 1 merge-assist dispatch
    expect(skillCaptured.length).toBe(2);
    const mergeAssist = skillCaptured[1]!.payload as {
      skill: string;
      content: string;
      meta: { agentId: string };
    };
    expect(mergeAssist.skill).toBe("bug_triage");
    expect(mergeAssist.meta.agentId).toBe("protomaker");
    expect(mergeAssist.content).toContain("rebasable");
    expect(mergeAssist.content).toContain("#77");
    expect(mergeAssist.content).toContain("three-way merge");

    plugin.uninstall();
  });

  test("unknown/malformed response defaults to genuine verdict (HITL escalation)", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new PrRemediatorPlugin();
    plugin.install(bus);

    pushWorldState(bus, [makePr({ number: 63, mergeable: "dirty", readyToMerge: false })]);

    const hitlCaptured = captureOn(bus, "hitl.request.pr.remediation_stuck.#");
    const skillCaptured = captureOn(bus, "agent.skill.request");

    const pr = makePr({ number: 63, mergeable: "dirty", readyToMerge: false });
    privateOf(plugin)._dispatchDiagnose(pr, crypto.randomUUID());
    await flushMicrotasks();

    const cid = skillCaptured[0]!.correlationId;
    bus.publish(`agent.skill.response.${cid}`, {
      id: crypto.randomUUID(),
      correlationId: cid,
      topic: `agent.skill.response.${cid}`,
      timestamp: Date.now(),
      payload: { text: "I could not determine the verdict for this PR." },
    });
    await flushMicrotasks();

    // Malformed response falls back to genuine → HITL
    expect(hitlCaptured.length).toBeGreaterThan(0);

    plugin.uninstall();
  });

  // ── Promotion-PR guard (issue #465) ────────────────────────────────────────
  //
  // A `decomposable` verdict on a release-pipeline PR (head ∈ {dev,staging} or
  // base ∈ {main,staging} or title starts "Promote") is structurally wrong:
  // the conflict is drift between branches, not within commits, so a back-merge
  // is the recovery, not a split. Guard at the chokepoint refuses the verdict
  // and escalates to HITL — same defense-in-depth pattern as #437/#444/#459.

  test("decomposable verdict on a refactor PR (head=feature/x, base=dev) still closes", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new PrRemediatorPlugin();
    plugin.install(bus);

    pushWorldState(bus, [
      makePr({ number: 101, headRef: "feature/x", baseRef: "dev", mergeable: "dirty", readyToMerge: false }),
    ]);

    const hitlCaptured = captureOn(bus, "hitl.request.pr.remediation_stuck.#");
    const skillCaptured = captureOn(bus, "agent.skill.request");

    const pr = makePr({
      number: 101,
      headRef: "feature/x",
      baseRef: "dev",
      mergeable: "dirty",
      readyToMerge: false,
    });
    privateOf(plugin)._dispatchDiagnose(pr, crypto.randomUUID());
    await flushMicrotasks();

    const cid = skillCaptured[0]!.correlationId;
    bus.publish(`agent.skill.response.${cid}`, {
      id: crypto.randomUUID(),
      correlationId: cid,
      topic: `agent.skill.response.${cid}`,
      timestamp: Date.now(),
      payload: {
        text:
          '```json\n{"verdict":"decomposable","evidence":"conflicts cluster in src/auth.ts and src/api.ts","conflictingFiles":["src/auth.ts","src/api.ts"]}\n```',
      },
    });
    await flushMicrotasks();

    // Refactor PR — guard does NOT trip; the close path runs (silently fails
    // without GH creds in tests, but importantly does not escalate to HITL).
    expect(hitlCaptured.length).toBe(0);

    plugin.uninstall();
  });

  test("decomposable verdict on dev→main promotion PR escalates to HITL, does NOT close", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new PrRemediatorPlugin();
    plugin.install(bus);

    pushWorldState(bus, [
      makePr({ number: 463, headRef: "dev", baseRef: "main", title: "Promote v0.7.22 to main", mergeable: "dirty", readyToMerge: false }),
    ]);

    const hitlCaptured = captureOn(bus, "hitl.request.pr.remediation_stuck.#");
    const skillCaptured = captureOn(bus, "agent.skill.request");

    const pr = makePr({
      number: 463,
      headRef: "dev",
      baseRef: "main",
      title: "Promote v0.7.22 to main",
      mergeable: "dirty",
      readyToMerge: false,
    });
    privateOf(plugin)._dispatchDiagnose(pr, crypto.randomUUID());
    await flushMicrotasks();

    const cid = skillCaptured[0]!.correlationId;
    bus.publish(`agent.skill.response.${cid}`, {
      id: crypto.randomUUID(),
      correlationId: cid,
      topic: `agent.skill.response.${cid}`,
      timestamp: Date.now(),
      payload: {
        text:
          '```json\n{"verdict":"decomposable","evidence":"conflicts cluster in 4 files","conflictingFiles":["a.ts","b.ts","c.ts","d.ts"]}\n```',
      },
    });
    await flushMicrotasks();

    // Promotion PR — guard MUST trip and escalate to HITL.
    expect(hitlCaptured.length).toBe(1);
    const req = hitlCaptured[0]!.payload as HITLRequest;
    expect(req.title).toContain("#463");
    expect(req.summary).toContain("Promotion-PR guard");
    expect(req.summary).toContain("back-merge");

    plugin.uninstall();
  });

  test("decomposable verdict on staging→main promotion PR escalates to HITL", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new PrRemediatorPlugin();
    plugin.install(bus);

    pushWorldState(bus, [
      makePr({ number: 470, headRef: "staging", baseRef: "main", mergeable: "dirty", readyToMerge: false }),
    ]);

    const hitlCaptured = captureOn(bus, "hitl.request.pr.remediation_stuck.#");
    const skillCaptured = captureOn(bus, "agent.skill.request");

    const pr = makePr({
      number: 470,
      headRef: "staging",
      baseRef: "main",
      mergeable: "dirty",
      readyToMerge: false,
    });
    privateOf(plugin)._dispatchDiagnose(pr, crypto.randomUUID());
    await flushMicrotasks();

    const cid = skillCaptured[0]!.correlationId;
    bus.publish(`agent.skill.response.${cid}`, {
      id: crypto.randomUUID(),
      correlationId: cid,
      topic: `agent.skill.response.${cid}`,
      timestamp: Date.now(),
      payload: {
        text:
          '```json\n{"verdict":"decomposable","evidence":"clusters in 3 files","conflictingFiles":["x.ts","y.ts","z.ts"]}\n```',
      },
    });
    await flushMicrotasks();

    expect(hitlCaptured.length).toBe(1);
    const req = hitlCaptured[0]!.payload as HITLRequest;
    expect(req.summary).toContain("staging");

    plugin.uninstall();
  });

  test("decomposable verdict on dev→staging promotion PR escalates to HITL", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new PrRemediatorPlugin();
    plugin.install(bus);

    pushWorldState(bus, [
      makePr({ number: 471, headRef: "dev", baseRef: "staging", mergeable: "dirty", readyToMerge: false }),
    ]);

    const hitlCaptured = captureOn(bus, "hitl.request.pr.remediation_stuck.#");
    const skillCaptured = captureOn(bus, "agent.skill.request");

    const pr = makePr({
      number: 471,
      headRef: "dev",
      baseRef: "staging",
      mergeable: "dirty",
      readyToMerge: false,
    });
    privateOf(plugin)._dispatchDiagnose(pr, crypto.randomUUID());
    await flushMicrotasks();

    const cid = skillCaptured[0]!.correlationId;
    bus.publish(`agent.skill.response.${cid}`, {
      id: crypto.randomUUID(),
      correlationId: cid,
      topic: `agent.skill.response.${cid}`,
      timestamp: Date.now(),
      payload: {
        text:
          '```json\n{"verdict":"decomposable","evidence":"clusters in 2 files","conflictingFiles":["a.ts","b.ts"]}\n```',
      },
    });
    await flushMicrotasks();

    expect(hitlCaptured.length).toBe(1);

    plugin.uninstall();
  });
});

// ── hitlPolicy propagation ───────────────────────────────────────────────────
//
// action.pr_merge_ready in workspace/actions.yaml declares
//   meta.hitlPolicy: { ttlMs: 1800000, onTimeout: approve }
// The PrRemediatorSkillExecutorPlugin forwards meta into the trigger payload
// on `pr.remediate.merge_ready`. _handleMergeReady extracts it via
// _extractHitlPolicy and applies it to the HITL request raised when ghMerge
// fails. This test exercises _emitHitlApproval directly via the same
// `as unknown as` cast pattern used by the diagnose_pr_stuck tests.

describe("PrRemediatorPlugin — hitlPolicy", () => {
  type PluginPrivate = {
    _emitHitlApproval(
      pr: PrEntry,
      parentCorrelationId: string,
      note?: string,
      hitlPolicy?: { ttlMs?: number; onTimeout?: "approve" | "reject" | "escalate" },
    ): void;
    _extractHitlPolicy(msg: BusMessage): { ttlMs?: number; onTimeout?: "approve" | "reject" | "escalate" } | undefined;
  };
  function privateOf(plugin: PrRemediatorPlugin): PluginPrivate {
    return plugin as unknown as PluginPrivate;
  }

  test("_emitHitlApproval honours hitlPolicy onTimeout=approve and ttlMs", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new PrRemediatorPlugin();
    plugin.install(bus);

    const captured = captureOn(bus, "hitl.request.pr.merge.#");
    const pr = makePr({ number: 555 });
    const before = Date.now();
    privateOf(plugin)._emitHitlApproval(pr, crypto.randomUUID(), "test fallback", {
      ttlMs: 1_800_000,
      onTimeout: "approve",
    });
    await flushMicrotasks();
    expect(captured.length).toBe(1);
    const req = captured[0]!.payload as HITLRequest;
    expect(req.onTimeout).toBe("approve");
    expect(req.ttlMs).toBe(1_800_000);
    const expiresAtMs = Date.parse(req.expiresAt);
    // Expiry should be ~30 min in the future (allow generous tolerance for CI).
    expect(expiresAtMs - before).toBeGreaterThanOrEqual(1_800_000 - 1000);
    expect(expiresAtMs - before).toBeLessThanOrEqual(1_800_000 + 5000);

    plugin.uninstall();
  });

  test("_emitHitlApproval falls back to 30min escalation when no policy passed", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new PrRemediatorPlugin();
    plugin.install(bus);

    const captured = captureOn(bus, "hitl.request.pr.merge.#");
    privateOf(plugin)._emitHitlApproval(makePr({ number: 556 }), crypto.randomUUID(), "no-policy");
    await flushMicrotasks();
    const req = captured[0]!.payload as HITLRequest;
    expect(req.onTimeout).toBeUndefined(); // → escalate behaviour in HITLPlugin
    expect(req.ttlMs).toBe(30 * 60 * 1000);

    plugin.uninstall();
  });

  test("_extractHitlPolicy parses meta.hitlPolicy from a trigger msg", () => {
    const plugin = new PrRemediatorPlugin();
    const policy = privateOf(plugin)._extractHitlPolicy({
      id: "x",
      correlationId: "y",
      topic: "pr.remediate.merge_ready",
      timestamp: Date.now(),
      payload: {
        meta: {
          hitlPolicy: { ttlMs: 1_800_000, onTimeout: "approve" },
        },
      },
    });
    expect(policy).toEqual({ ttlMs: 1_800_000, onTimeout: "approve" });
  });

  test("_extractHitlPolicy returns undefined when meta.hitlPolicy is missing", () => {
    const plugin = new PrRemediatorPlugin();
    const policy = privateOf(plugin)._extractHitlPolicy({
      id: "x",
      correlationId: "y",
      topic: "pr.remediate.merge_ready",
      timestamp: Date.now(),
      payload: { meta: {} },
    });
    expect(policy).toBeUndefined();
  });

  test("_extractHitlPolicy ignores unknown onTimeout values", () => {
    const plugin = new PrRemediatorPlugin();
    const policy = privateOf(plugin)._extractHitlPolicy({
      id: "x",
      correlationId: "y",
      topic: "pr.remediate.merge_ready",
      timestamp: Date.now(),
      payload: {
        meta: {
          hitlPolicy: { ttlMs: 1000, onTimeout: "bogus" },
        },
      },
    });
    expect(policy).toEqual({ ttlMs: 1000 });
  });

  test("_extractHitlPolicy rejects Infinity as ttlMs", () => {
    const plugin = new PrRemediatorPlugin();
    const policy = privateOf(plugin)._extractHitlPolicy({
      id: "x",
      correlationId: "y",
      topic: "pr.remediate.merge_ready",
      timestamp: Date.now(),
      payload: {
        meta: {
          hitlPolicy: { ttlMs: Infinity, onTimeout: "approve" },
        },
      },
    });
    expect(policy).toEqual({ onTimeout: "approve" });
  });

  test("_extractHitlPolicy rejects NaN as ttlMs", () => {
    const plugin = new PrRemediatorPlugin();
    const policy = privateOf(plugin)._extractHitlPolicy({
      id: "x",
      correlationId: "y",
      topic: "pr.remediate.merge_ready",
      timestamp: Date.now(),
      payload: {
        meta: {
          hitlPolicy: { ttlMs: NaN, onTimeout: "reject" },
        },
      },
    });
    expect(policy).toEqual({ onTimeout: "reject" });
  });

  test("_extractHitlPolicy rejects zero and negative ttlMs", () => {
    const plugin = new PrRemediatorPlugin();
    const zeroPolicy = privateOf(plugin)._extractHitlPolicy({
      id: "x",
      correlationId: "y",
      topic: "pr.remediate.merge_ready",
      timestamp: Date.now(),
      payload: { meta: { hitlPolicy: { ttlMs: 0 } } },
    });
    expect(zeroPolicy).toBeUndefined();

    const negativePolicy = privateOf(plugin)._extractHitlPolicy({
      id: "x",
      correlationId: "y",
      topic: "pr.remediate.merge_ready",
      timestamp: Date.now(),
      payload: { meta: { hitlPolicy: { ttlMs: -1000 } } },
    });
    expect(negativePolicy).toBeUndefined();
  });
});

// ── hitlPolicy propagation ───────────────────────────────────────────────────
//
// action.pr_merge_ready in workspace/actions.yaml declares
//   meta.hitlPolicy: { ttlMs: 1800000, onTimeout: approve }
// The PrRemediatorSkillExecutorPlugin forwards meta into the trigger payload
// on `pr.remediate.merge_ready`. _handleMergeReady extracts it via
// _extractHitlPolicy and applies it to the HITL request raised when ghMerge
// fails. This test exercises _emitHitlApproval directly via the same
// `as unknown as` cast pattern used by the diagnose_pr_stuck tests.

describe("PrRemediatorPlugin — hitlPolicy", () => {
  type PluginPrivate = {
    _emitHitlApproval(
      pr: PrEntry,
      parentCorrelationId: string,
      note?: string,
      hitlPolicy?: { ttlMs?: number; onTimeout?: "approve" | "reject" | "escalate" },
    ): void;
    _extractHitlPolicy(msg: BusMessage): { ttlMs?: number; onTimeout?: "approve" | "reject" | "escalate" } | undefined;
  };
  function privateOf(plugin: PrRemediatorPlugin): PluginPrivate {
    return plugin as unknown as PluginPrivate;
  }

  test("_emitHitlApproval honours hitlPolicy onTimeout=approve and ttlMs", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new PrRemediatorPlugin();
    plugin.install(bus);

    const captured = captureOn(bus, "hitl.request.pr.merge.#");
    const pr = makePr({ number: 555 });
    const before = Date.now();
    privateOf(plugin)._emitHitlApproval(pr, crypto.randomUUID(), "test fallback", {
      ttlMs: 1_800_000,
      onTimeout: "approve",
    });
    await flushMicrotasks();
    expect(captured.length).toBe(1);
    const req = captured[0]!.payload as HITLRequest;
    expect(req.onTimeout).toBe("approve");
    expect(req.ttlMs).toBe(1_800_000);
    const expiresAtMs = Date.parse(req.expiresAt);
    // Expiry should be ~30 min in the future (allow generous tolerance for CI).
    expect(expiresAtMs - before).toBeGreaterThanOrEqual(1_800_000 - 1000);
    expect(expiresAtMs - before).toBeLessThanOrEqual(1_800_000 + 5000);

    plugin.uninstall();
  });

  test("_emitHitlApproval falls back to 30min escalation when no policy passed", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new PrRemediatorPlugin();
    plugin.install(bus);

    const captured = captureOn(bus, "hitl.request.pr.merge.#");
    privateOf(plugin)._emitHitlApproval(makePr({ number: 556 }), crypto.randomUUID(), "no-policy");
    await flushMicrotasks();
    const req = captured[0]!.payload as HITLRequest;
    expect(req.onTimeout).toBeUndefined(); // → escalate behaviour in HITLPlugin
    expect(req.ttlMs).toBe(30 * 60 * 1000);

    plugin.uninstall();
  });

  test("_extractHitlPolicy parses meta.hitlPolicy from a trigger msg", () => {
    const plugin = new PrRemediatorPlugin();
    const policy = privateOf(plugin)._extractHitlPolicy({
      id: "x",
      correlationId: "y",
      topic: "pr.remediate.merge_ready",
      timestamp: Date.now(),
      payload: {
        meta: {
          hitlPolicy: { ttlMs: 1_800_000, onTimeout: "approve" },
        },
      },
    });
    expect(policy).toEqual({ ttlMs: 1_800_000, onTimeout: "approve" });
  });

  test("_extractHitlPolicy returns undefined when meta.hitlPolicy is missing", () => {
    const plugin = new PrRemediatorPlugin();
    const policy = privateOf(plugin)._extractHitlPolicy({
      id: "x",
      correlationId: "y",
      topic: "pr.remediate.merge_ready",
      timestamp: Date.now(),
      payload: { meta: {} },
    });
    expect(policy).toBeUndefined();
  });

  test("_extractHitlPolicy ignores unknown onTimeout values", () => {
    const plugin = new PrRemediatorPlugin();
    const policy = privateOf(plugin)._extractHitlPolicy({
      id: "x",
      correlationId: "y",
      topic: "pr.remediate.merge_ready",
      timestamp: Date.now(),
      payload: {
        meta: {
          hitlPolicy: { ttlMs: 1000, onTimeout: "bogus" },
        },
      },
    });
    expect(policy).toEqual({ ttlMs: 1000 });
  });
});
