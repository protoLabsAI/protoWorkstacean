import { describe, expect, it } from "bun:test";
import { InMemoryEventBus } from "../../bus.ts";
import { FeatureRemediationPlugin, type FeatureBlockedPayload } from "../feature-remediation.ts";

/** A controllable clock so we can drive cooldown + cap deterministically. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function blocked(p: Partial<FeatureBlockedPayload> = {}): FeatureBlockedPayload {
  return { projectSlug: "demo", featureId: "feat-1", ...p };
}

function publishBlocked(bus: InMemoryEventBus, payload: FeatureBlockedPayload) {
  bus.publish("feature.blocked", {
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    topic: "feature.blocked",
    timestamp: 0,
    payload,
  });
}

/** Capture every publish on a topic. */
function capture(bus: InMemoryEventBus, topic: string): any[] {
  const seen: any[] = [];
  bus.subscribe(topic, "test", (m) => {
    seen.push(m.payload);
  });
  return seen;
}

/** Allow pending microtasks (from async handlers) to settle. */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Minimal ProjectRegistry mock for origin-truth tests. */
function mockRegistry(opts: { slug?: string; github?: { owner: string; repo: string } } = {}) {
  const project = opts.github ? { slug: opts.slug ?? "demo", path: "/demo", github: opts.github } : undefined;
  return {
    getBySlug: (s: string) => (s === (opts.slug ?? "demo") ? project : undefined),
    getByPath: () => undefined,
  } as any;
}

describe("FeatureRemediationPlugin", () => {
  it("ignores dependency-unsatisfied kinds (protoMaker self-heals)", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new FeatureRemediationPlugin();
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");
    const hitl = capture(bus, "operator.message.request");

    publishBlocked(bus, blocked({ kind: "dependency_unsatisfied" }));
    publishBlocked(bus, blocked({ kind: "external_dependency_unsatisfied" }));
    await drainMicrotasks();

    expect(dispatches).toHaveLength(0);
    expect(hitl).toHaveLength(0);
    plugin.uninstall();
  });

  it("drops events with no featureId", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new FeatureRemediationPlugin();
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");

    publishBlocked(bus, { projectSlug: "demo", featureId: "" } as FeatureBlockedPayload);
    await drainMicrotasks();

    expect(dispatches).toHaveLength(0);
    plugin.uninstall();
  });

  it("escalates cost/runtime/quota kinds directly to the operator (no auto-action)", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new FeatureRemediationPlugin();
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");
    const hitl = capture(bus, "operator.message.request");

    publishBlocked(bus, blocked({ kind: "cost_exceeded", reason: "budget blown" }));
    await drainMicrotasks();

    expect(dispatches).toHaveLength(0);
    expect(hitl).toHaveLength(1);
    expect(hitl[0].type).toBe("operator_message_request");
    expect(hitl[0].urgency).toBe("high");
    expect(hitl[0].from).toBe("feature-remediation");
    expect(hitl[0].topic).toBe("feature-blocked/demo/feat-1");
    plugin.uninstall();
  });

  it("does not re-escalate a HITL kind that fires repeatedly", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new FeatureRemediationPlugin();
    plugin.install(bus);
    const hitl = capture(bus, "operator.message.request");

    publishBlocked(bus, blocked({ kind: "quota" }));
    publishBlocked(bus, blocked({ kind: "quota" }));
    publishBlocked(bus, blocked({ kind: "quota" }));
    await drainMicrotasks();

    expect(hitl).toHaveLength(1);
    plugin.uninstall();
  });

  it("dispatches Roxy unblock_feature for remediable kinds with full context", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new FeatureRemediationPlugin();
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");

    publishBlocked(
      bus,
      blocked({ kind: "ci_failure", reason: "tests red", prNumber: 42, branchName: "feature/x", featureTitle: "Do X" }),
    );
    await drainMicrotasks();

    expect(dispatches).toHaveLength(1);
    const d = dispatches[0];
    expect(d.skill).toBe("unblock_feature");
    expect(d.targets).toEqual(["roxy"]);
    expect(d.meta.systemActor).toBe("feature-remediation");
    expect(d.meta.featureId).toBe("feat-1");
    expect(d.meta.kind).toBe("ci_failure");
    expect(d.meta.prNumber).toBe(42);
    expect(d.content).toContain("PR #42");
    expect(d.content).toContain("Do X");
    plugin.uninstall();
  });

  it("respects the cooldown between attempts on the same feature", async () => {
    const bus = new InMemoryEventBus();
    const clock = fakeClock();
    const plugin = new FeatureRemediationPlugin({ now: clock.now });
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");

    publishBlocked(bus, blocked({ kind: "ci_failure" }));
    await drainMicrotasks();
    expect(dispatches).toHaveLength(1);

    // Within cooldown — skipped.
    clock.advance(60_000);
    publishBlocked(bus, blocked({ kind: "ci_failure" }));
    await drainMicrotasks();
    expect(dispatches).toHaveLength(1);

    // Past cooldown — second attempt dispatches.
    clock.advance(5 * 60_000);
    publishBlocked(bus, blocked({ kind: "ci_failure" }));
    await drainMicrotasks();
    expect(dispatches).toHaveLength(2);
    plugin.uninstall();
  });

  it("bounds auto-remediation and escalates ONCE on exhaustion", async () => {
    const bus = new InMemoryEventBus();
    const clock = fakeClock();
    const plugin = new FeatureRemediationPlugin({ now: clock.now });
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");
    const hitl = capture(bus, "operator.message.request");

    // 3 attempts, each past cooldown.
    for (let i = 0; i < 3; i++) {
      publishBlocked(bus, blocked({ kind: "ci_failure" }));
      clock.advance(6 * 60_000);
      await drainMicrotasks();
    }
    expect(dispatches).toHaveLength(3);
    expect(hitl).toHaveLength(0);

    // 4th (and 5th) → exhausted → escalate exactly once.
    publishBlocked(bus, blocked({ kind: "ci_failure" }));
    clock.advance(6 * 60_000);
    publishBlocked(bus, blocked({ kind: "ci_failure" }));
    await drainMicrotasks();

    expect(dispatches).toHaveLength(3);
    expect(hitl).toHaveLength(1);
    expect(hitl[0].urgency).toBe("medium");
    plugin.uninstall();
  });

  it("clears the tracker on feature.completed so a re-block gets a fresh budget", async () => {
    const bus = new InMemoryEventBus();
    const clock = fakeClock();
    const plugin = new FeatureRemediationPlugin({ now: clock.now });
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");

    publishBlocked(bus, blocked({ kind: "ci_failure" }));
    await drainMicrotasks();
    expect(dispatches).toHaveLength(1);

    // Feature recovered — feature.completed is the event protoMaker actually emits.
    bus.publish("feature.completed", {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: "feature.completed",
      timestamp: 0,
      payload: blocked(),
    });

    // Re-block immediately — fresh budget means an immediate dispatch (no cooldown carryover).
    publishBlocked(bus, blocked({ kind: "ci_failure" }));
    await drainMicrotasks();
    expect(dispatches).toHaveLength(2);
    plugin.uninstall();
  });

  it("clears the tracker on feature.failed so a re-block gets a fresh budget", async () => {
    const bus = new InMemoryEventBus();
    const clock = fakeClock();
    const plugin = new FeatureRemediationPlugin({ now: clock.now });
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");

    publishBlocked(bus, blocked({ kind: "ci_failure" }));
    await drainMicrotasks();
    expect(dispatches).toHaveLength(1);

    // Feature failed — also clears the tracker.
    bus.publish("feature.failed", {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: "feature.failed",
      timestamp: 0,
      payload: blocked(),
    });

    // Re-block immediately — fresh budget.
    publishBlocked(bus, blocked({ kind: "ci_failure" }));
    await drainMicrotasks();
    expect(dispatches).toHaveLength(2);
    plugin.uninstall();
  });

  it("keys per-feature so two blocked features are remediated independently", async () => {
    const bus = new InMemoryEventBus();
    const plugin = new FeatureRemediationPlugin();
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");

    publishBlocked(bus, blocked({ featureId: "feat-1", kind: "ci_failure" }));
    publishBlocked(bus, blocked({ featureId: "feat-2", kind: "ci_failure" }));
    await drainMicrotasks();

    expect(dispatches).toHaveLength(2);
    expect(dispatches.map((d) => d.meta.featureId).sort()).toEqual(["feat-1", "feat-2"]);
    plugin.uninstall();
  });

  // ── Origin-truth checks before escalation ──────────────────────────────

  it("suppresses HITL escalation when PR already merged (runtime_exceeded)", async () => {
    const bus = new InMemoryEventBus();
    const registry = mockRegistry({ slug: "demo", github: { owner: "org", repo: "repo" } });
    const plugin = new FeatureRemediationPlugin({
      projectRegistry: registry,
      fetchPrStateFn: () => Promise.resolve({ number: 4121, state: "closed", merged: true }),
    });
    plugin.install(bus);
    const hitl = capture(bus, "operator.message.request");

    publishBlocked(bus, blocked({ kind: "runtime_exceeded", prNumber: 4121, reason: "65.9 min >= cap 60 min" }));
    await drainMicrotasks();

    expect(hitl).toHaveLength(0);
    plugin.uninstall();
  });

  it("suppresses HITL escalation when PR already merged (cost_exceeded)", async () => {
    const bus = new InMemoryEventBus();
    const registry = mockRegistry({ slug: "demo", github: { owner: "org", repo: "repo" } });
    const plugin = new FeatureRemediationPlugin({
      projectRegistry: registry,
      fetchPrStateFn: () => Promise.resolve({ number: 100, state: "closed", merged: true }),
    });
    plugin.install(bus);
    const hitl = capture(bus, "operator.message.request");

    publishBlocked(bus, blocked({ kind: "cost_exceeded", prNumber: 100 }));
    await drainMicrotasks();

    expect(hitl).toHaveLength(0);
    plugin.uninstall();
  });

  it("suppresses auto-remediation-exhaustion escalation when PR already merged", async () => {
    const bus = new InMemoryEventBus();
    const clock = fakeClock();
    const registry = mockRegistry({ slug: "demo", github: { owner: "org", repo: "repo" } });
    const plugin = new FeatureRemediationPlugin({
      now: clock.now,
      projectRegistry: registry,
      fetchPrStateFn: () => Promise.resolve({ number: 42, state: "closed", merged: true }),
    });
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");
    const hitl = capture(bus, "operator.message.request");

    // 3 attempts, each past cooldown.
    for (let i = 0; i < 3; i++) {
      publishBlocked(bus, blocked({ kind: "ci_failure", prNumber: 42 }));
      clock.advance(6 * 60_000);
      await drainMicrotasks();
    }
    expect(dispatches).toHaveLength(3);
    expect(hitl).toHaveLength(0);

    // 4th → exhausted, but PR merged → no escalation.
    publishBlocked(bus, blocked({ kind: "ci_failure", prNumber: 42 }));
    await drainMicrotasks();

    expect(dispatches).toHaveLength(3);
    expect(hitl).toHaveLength(0);
    plugin.uninstall();
  });

  it("still escalates when PR is open (not merged)", async () => {
    const bus = new InMemoryEventBus();
    const registry = mockRegistry({ slug: "demo", github: { owner: "org", repo: "repo" } });
    const plugin = new FeatureRemediationPlugin({
      projectRegistry: registry,
      fetchPrStateFn: () => Promise.resolve({ number: 42, state: "open", merged: false }),
    });
    plugin.install(bus);
    const hitl = capture(bus, "operator.message.request");

    publishBlocked(bus, blocked({ kind: "runtime_exceeded", prNumber: 42 }));
    await drainMicrotasks();

    expect(hitl).toHaveLength(1);
    plugin.uninstall();
  });

  it("still escalates when PR is closed but not merged", async () => {
    const bus = new InMemoryEventBus();
    const registry = mockRegistry({ slug: "demo", github: { owner: "org", repo: "repo" } });
    const plugin = new FeatureRemediationPlugin({
      projectRegistry: registry,
      fetchPrStateFn: () => Promise.resolve({ number: 42, state: "closed", merged: false }),
    });
    plugin.install(bus);
    const hitl = capture(bus, "operator.message.request");

    publishBlocked(bus, blocked({ kind: "runtime_exceeded", prNumber: 42 }));
    await drainMicrotasks();

    expect(hitl).toHaveLength(1);
    plugin.uninstall();
  });

  it("escalates when PR state fetch fails (unknown = genuinely blocked)", async () => {
    const bus = new InMemoryEventBus();
    const registry = mockRegistry({ slug: "demo", github: { owner: "org", repo: "repo" } });
    const plugin = new FeatureRemediationPlugin({
      projectRegistry: registry,
      fetchPrStateFn: () => Promise.resolve(null), // fetch failed
    });
    plugin.install(bus);
    const hitl = capture(bus, "operator.message.request");

    publishBlocked(bus, blocked({ kind: "runtime_exceeded", prNumber: 42 }));
    await drainMicrotasks();

    expect(hitl).toHaveLength(1);
    plugin.uninstall();
  });

  it("escalates when no PR number (nothing to check)", async () => {
    const bus = new InMemoryEventBus();
    const registry = mockRegistry({ slug: "demo", github: { owner: "org", repo: "repo" } });
    const plugin = new FeatureRemediationPlugin({
      projectRegistry: registry,
      fetchPrStateFn: () => Promise.resolve({ number: 42, state: "closed", merged: true }),
    });
    plugin.install(bus);
    const hitl = capture(bus, "operator.message.request");

    // No prNumber → origin truth check skipped → escalate normally.
    publishBlocked(bus, blocked({ kind: "runtime_exceeded" }));
    await drainMicrotasks();

    expect(hitl).toHaveLength(1);
    plugin.uninstall();
  });

  it("escalates when project not in registry (no GitHub coords)", async () => {
    const bus = new InMemoryEventBus();
    const registry = mockRegistry({}); // empty registry
    const plugin = new FeatureRemediationPlugin({
      projectRegistry: registry,
      fetchPrStateFn: () => Promise.resolve({ number: 42, state: "closed", merged: true }),
    });
    plugin.install(bus);
    const hitl = capture(bus, "operator.message.request");

    publishBlocked(bus, blocked({ kind: "runtime_exceeded", prNumber: 42 }));
    await drainMicrotasks();

    expect(hitl).toHaveLength(1);
    plugin.uninstall();
  });

  it("escalates when no projectRegistry configured (legacy behavior)", async () => {
    const bus = new InMemoryEventBus();
    // No projectRegistry → origin truth check disabled → escalate normally.
    const plugin = new FeatureRemediationPlugin();
    plugin.install(bus);
    const hitl = capture(bus, "operator.message.request");

    publishBlocked(bus, blocked({ kind: "runtime_exceeded", prNumber: 4121 }));
    await drainMicrotasks();

    expect(hitl).toHaveLength(1);
    plugin.uninstall();
  });
});
