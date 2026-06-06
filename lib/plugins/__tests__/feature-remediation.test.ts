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

describe("FeatureRemediationPlugin", () => {
  it("ignores dependency-unsatisfied kinds (protoMaker self-heals)", () => {
    const bus = new InMemoryEventBus();
    const plugin = new FeatureRemediationPlugin();
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");
    const hitl = capture(bus, "operator.message.request");

    publishBlocked(bus, blocked({ kind: "dependency_unsatisfied" }));
    publishBlocked(bus, blocked({ kind: "external_dependency_unsatisfied" }));

    expect(dispatches).toHaveLength(0);
    expect(hitl).toHaveLength(0);
    plugin.uninstall();
  });

  it("drops events with no featureId", () => {
    const bus = new InMemoryEventBus();
    const plugin = new FeatureRemediationPlugin();
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");

    publishBlocked(bus, { projectSlug: "demo", featureId: "" } as FeatureBlockedPayload);

    expect(dispatches).toHaveLength(0);
    plugin.uninstall();
  });

  it("escalates cost/runtime/quota kinds directly to the operator (no auto-action)", () => {
    const bus = new InMemoryEventBus();
    const plugin = new FeatureRemediationPlugin();
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");
    const hitl = capture(bus, "operator.message.request");

    publishBlocked(bus, blocked({ kind: "cost_exceeded", reason: "budget blown" }));

    expect(dispatches).toHaveLength(0);
    expect(hitl).toHaveLength(1);
    expect(hitl[0].type).toBe("operator_message_request");
    expect(hitl[0].urgency).toBe("high");
    expect(hitl[0].from).toBe("feature-remediation");
    expect(hitl[0].topic).toBe("feature-blocked/demo/feat-1");
    plugin.uninstall();
  });

  it("does not re-escalate a HITL kind that fires repeatedly", () => {
    const bus = new InMemoryEventBus();
    const plugin = new FeatureRemediationPlugin();
    plugin.install(bus);
    const hitl = capture(bus, "operator.message.request");

    publishBlocked(bus, blocked({ kind: "quota" }));
    publishBlocked(bus, blocked({ kind: "quota" }));
    publishBlocked(bus, blocked({ kind: "quota" }));

    expect(hitl).toHaveLength(1);
    plugin.uninstall();
  });

  it("dispatches Roxy unblock_feature for remediable kinds with full context", () => {
    const bus = new InMemoryEventBus();
    const plugin = new FeatureRemediationPlugin();
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");

    publishBlocked(
      bus,
      blocked({ kind: "ci_failure", reason: "tests red", prNumber: 42, branchName: "feature/x", featureTitle: "Do X" }),
    );

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

  it("respects the cooldown between attempts on the same feature", () => {
    const bus = new InMemoryEventBus();
    const clock = fakeClock();
    const plugin = new FeatureRemediationPlugin({ now: clock.now });
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");

    publishBlocked(bus, blocked({ kind: "ci_failure" }));
    expect(dispatches).toHaveLength(1);

    // Within cooldown — skipped.
    clock.advance(60_000);
    publishBlocked(bus, blocked({ kind: "ci_failure" }));
    expect(dispatches).toHaveLength(1);

    // Past cooldown — second attempt dispatches.
    clock.advance(5 * 60_000);
    publishBlocked(bus, blocked({ kind: "ci_failure" }));
    expect(dispatches).toHaveLength(2);
    plugin.uninstall();
  });

  it("bounds auto-remediation and escalates ONCE on exhaustion", () => {
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
    }
    expect(dispatches).toHaveLength(3);
    expect(hitl).toHaveLength(0);

    // 4th (and 5th) → exhausted → escalate exactly once.
    publishBlocked(bus, blocked({ kind: "ci_failure" }));
    clock.advance(6 * 60_000);
    publishBlocked(bus, blocked({ kind: "ci_failure" }));

    expect(dispatches).toHaveLength(3);
    expect(hitl).toHaveLength(1);
    expect(hitl[0].urgency).toBe("medium");
    plugin.uninstall();
  });

  it("clears the tracker on feature.completed so a re-block gets a fresh budget", () => {
    const bus = new InMemoryEventBus();
    const clock = fakeClock();
    const plugin = new FeatureRemediationPlugin({ now: clock.now });
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");

    publishBlocked(bus, blocked({ kind: "ci_failure" }));
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
    expect(dispatches).toHaveLength(2);
    plugin.uninstall();
  });

  it("clears the tracker on feature.failed so a re-block gets a fresh budget", () => {
    const bus = new InMemoryEventBus();
    const clock = fakeClock();
    const plugin = new FeatureRemediationPlugin({ now: clock.now });
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");

    publishBlocked(bus, blocked({ kind: "ci_failure" }));
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
    expect(dispatches).toHaveLength(2);
    plugin.uninstall();
  });

  it("keys per-feature so two blocked features are remediated independently", () => {
    const bus = new InMemoryEventBus();
    const plugin = new FeatureRemediationPlugin();
    plugin.install(bus);
    const dispatches = capture(bus, "agent.skill.request");

    publishBlocked(bus, blocked({ featureId: "feat-1", kind: "ci_failure" }));
    publishBlocked(bus, blocked({ featureId: "feat-2", kind: "ci_failure" }));

    expect(dispatches).toHaveLength(2);
    expect(dispatches.map((d) => d.meta.featureId).sort()).toEqual(["feat-1", "feat-2"]);
    plugin.uninstall();
  });
});
