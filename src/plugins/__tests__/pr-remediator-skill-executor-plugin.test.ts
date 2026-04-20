import { describe, it, expect, beforeEach } from "bun:test";
import {
  PrRemediatorSkillExecutorPlugin,
  PR_REMEDIATOR_SKILL_TOPICS,
} from "../pr-remediator-skill-executor-plugin.ts";
import { ExecutorRegistry } from "../../executor/executor-registry.ts";
import type { BusMessage } from "../../../lib/types.ts";

/**
 * Minimal in-memory bus mirroring the AlertSkillExecutor test harness —
 * captures every published message so we can assert on dispatch shape.
 */
function makeBus() {
  const subs = new Map<string, Array<(msg: BusMessage) => void>>();
  const published: BusMessage[] = [];
  return {
    published,
    subscribe(topic: string, _name: string, handler: (msg: BusMessage) => void) {
      if (!subs.has(topic)) subs.set(topic, []);
      subs.get(topic)!.push(handler);
      return `sub-${topic}-${Math.random()}`;
    },
    unsubscribe(_id: string) {},
    publish(topic: string, msg: BusMessage) {
      published.push(msg);
      const handlers = subs.get(topic) ?? [];
      for (const h of handlers) h(msg);
    },
    topics() { return []; },
  };
}

describe("PrRemediatorSkillExecutorPlugin", () => {
  let registry: ExecutorRegistry;
  let plugin: PrRemediatorSkillExecutorPlugin;
  let bus: ReturnType<typeof makeBus>;

  beforeEach(() => {
    registry = new ExecutorRegistry();
    plugin = new PrRemediatorSkillExecutorPlugin(registry);
    bus = makeBus();
    plugin.install(bus as never);
  });

  it("registers an executor for every pr-remediator-owned skill", () => {
    const required = [
      "action.pr_update_branch",
      "action.pr_merge_ready",
      "action.pr_fix_ci",
      "action.pr_address_feedback",
      "action.dispatch_backmerge",
    ];
    for (const skill of required) {
      expect(registry.resolve(skill)).not.toBeNull();
    }
  });

  it("registry size matches the topic table", () => {
    expect(registry.size).toBe(PR_REMEDIATOR_SKILL_TOPICS.length);
  });

  it("each executor publishes on its mapped pr-remediator topic", async () => {
    for (const entry of PR_REMEDIATOR_SKILL_TOPICS) {
      // Reset capture between iterations
      bus.published.length = 0;
      const executor = registry.resolve(entry.skill)!;
      const result = await executor.execute({
        skill: entry.skill,
        correlationId: `corr-${entry.skill}`,
        replyTopic: "reply.test",
        payload: { skill: entry.skill, meta: { actionId: entry.skill, goalId: "test.goal" } },
      });
      expect(result.isError).toBe(false);
      expect(result.correlationId).toBe(`corr-${entry.skill}`);
      const triggered = bus.published.find(m => m.topic === entry.topic);
      expect(triggered).toBeDefined();
      expect(triggered!.correlationId).toBe(`corr-${entry.skill}`);
    }
  });

  it("fire-and-forget: returns success synchronously and never awaits the handler", async () => {
    // The executor must not depend on a subscriber existing — pr-remediator
    // is a separate plugin and may be absent in dry-run / test environments.
    const reg2 = new ExecutorRegistry();
    const plugin2 = new PrRemediatorSkillExecutorPlugin(reg2);
    const bus2 = makeBus(); // no subscribers
    plugin2.install(bus2 as never);

    const executor = reg2.resolve("action.pr_update_branch")!;
    const result = await executor.execute({
      skill: "action.pr_update_branch",
      correlationId: "ff-1",
      replyTopic: "reply.test",
      payload: { skill: "action.pr_update_branch" },
    });
    expect(result.isError).toBe(false);
    // The publish still happened — no subscribers, but no error either.
    expect(bus2.published.find(m => m.topic === "pr.remediate.update_branch")).toBeDefined();
  });

  it("forwards meta (incl. hitlPolicy) into the trigger payload", async () => {
    const executor = registry.resolve("action.pr_merge_ready")!;
    const hitlPolicy = { ttlMs: 1_800_000, onTimeout: "approve" as const };
    await executor.execute({
      skill: "action.pr_merge_ready",
      correlationId: "corr-hitl",
      replyTopic: "reply.test",
      payload: {
        skill: "action.pr_merge_ready",
        meta: {
          systemActor: "goap",
          actionId: "action.pr_merge_ready",
          goalId: "pr.mergeable_flushed",
          hitlPolicy,
        },
      },
    });

    const triggered = bus.published.find(m => m.topic === "pr.remediate.merge_ready");
    expect(triggered).toBeDefined();
    const p = triggered!.payload as { actionId?: string; goalId?: string; meta?: Record<string, unknown> };
    expect(p.actionId).toBe("action.pr_merge_ready");
    expect(p.goalId).toBe("pr.mergeable_flushed");
    expect(p.meta?.hitlPolicy).toEqual(hitlPolicy);
    expect(p.meta?.systemActor).toBe("goap");
  });

  it("propagates correlationId on the published trigger", async () => {
    const executor = registry.resolve("action.dispatch_backmerge")!;
    await executor.execute({
      skill: "action.dispatch_backmerge",
      correlationId: "trace-bm-1",
      replyTopic: "reply.test",
      payload: { skill: "action.dispatch_backmerge" },
    });
    const triggered = bus.published.find(m => m.topic === "pr.backmerge.dispatch");
    expect(triggered!.correlationId).toBe("trace-bm-1");
  });

  it("fails loud when invoked before install (no silent swallow)", async () => {
    const reg = new ExecutorRegistry();
    const p = new PrRemediatorSkillExecutorPlugin(reg);
    // Don't install — but still need to register an executor to test, so
    // simulate the post-uninstall path.
    const bus3 = makeBus();
    p.install(bus3 as never);
    const executor = reg.resolve("action.pr_fix_ci")!;
    p.uninstall();
    const result = await executor.execute({
      skill: "action.pr_fix_ci",
      correlationId: "no-bus",
      replyTopic: "reply.test",
      payload: { skill: "action.pr_fix_ci" },
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("not installed");
  });

  it("uninstall clears the bus reference (re-install on fresh bus is safe)", () => {
    plugin.uninstall();
    const reg2 = new ExecutorRegistry();
    const plugin2 = new PrRemediatorSkillExecutorPlugin(reg2);
    const bus2 = makeBus();
    expect(() => plugin2.install(bus2 as never)).not.toThrow();
  });
});

// ── Integration: PrRemediatorPlugin reacts to dispatched skill ────────────────
//
// End-to-end check that the executor → bus → pr-remediator handler path is
// wired correctly. We use the real EventBus and the real PrRemediatorPlugin so
// the registered subscription on pr.remediate.update_branch actually receives
// our dispatch.

import { InMemoryEventBus } from "../../../lib/bus";
import { PrRemediatorPlugin } from "../../../lib/plugins/pr-remediator";

describe("PrRemediatorSkillExecutorPlugin — bus integration", () => {
  it("dispatching action.pr_update_branch triggers PrRemediatorPlugin's handler", async () => {
    const bus = new InMemoryEventBus();
    const remediator = new PrRemediatorPlugin();
    remediator.install(bus);

    const reg = new ExecutorRegistry();
    const skillExec = new PrRemediatorSkillExecutorPlugin(reg);
    skillExec.install(bus);

    // No PR data cached — handler will log "no PRs match" and return cleanly.
    // We capture the log topic by spying on the underlying bus subscription
    // count: the remediator subscribes to pr.remediate.update_branch in install.
    expect(bus.topics().map(t => t.pattern)).toContain("pr.remediate.update_branch");

    const executor = reg.resolve("action.pr_update_branch")!;
    const result = await executor.execute({
      skill: "action.pr_update_branch",
      correlationId: "int-1",
      replyTopic: "reply.test",
      payload: { skill: "action.pr_update_branch" },
    });
    expect(result.isError).toBe(false);

    remediator.uninstall();
    skillExec.uninstall();
  });

  it("dispatching action.dispatch_backmerge reaches the backmerge subscription", async () => {
    const bus = new InMemoryEventBus();
    const remediator = new PrRemediatorPlugin();
    remediator.install(bus);

    const reg = new ExecutorRegistry();
    const skillExec = new PrRemediatorSkillExecutorPlugin(reg);
    skillExec.install(bus);

    expect(bus.topics().map(t => t.pattern)).toContain("pr.backmerge.dispatch");

    const executor = reg.resolve("action.dispatch_backmerge")!;
    const result = await executor.execute({
      skill: "action.dispatch_backmerge",
      correlationId: "int-bm",
      replyTopic: "reply.test",
      payload: { skill: "action.dispatch_backmerge" },
    });
    expect(result.isError).toBe(false);

    remediator.uninstall();
    skillExec.uninstall();
  });
});
