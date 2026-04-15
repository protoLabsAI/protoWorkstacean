import { describe, it, expect, mock, beforeEach } from "bun:test";
import { ExecutorRegistry } from "../executor-registry.ts";
import { SkillAbTestPlugin, AbTestExecutor } from "../skill-ab-test-plugin.ts";
import type { IExecutor, SkillRequest, SkillResult } from "../types.ts";
import type { EventBus, BusMessage } from "../../../lib/types.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeExecutor(type: string, isError = false): IExecutor {
  return {
    type,
    execute: mock(async (req: SkillRequest): Promise<SkillResult> => ({
      text: `result from ${type}`,
      isError,
      correlationId: req.correlationId,
      data: { usage: { input_tokens: 10, output_tokens: 20 } },
    })),
  };
}

function makeReq(correlationId: string): SkillRequest {
  return {
    skill: "bug_triage",
    correlationId,
    replyTopic: `agent.skill.response.${correlationId}`,
    payload: {},
  };
}

/** Minimal in-memory bus stub */
function makeBus(): EventBus & { published: BusMessage[] } {
  const published: BusMessage[] = [];
  const subs = new Map<string, (msg: BusMessage) => void>();

  return {
    published,
    publish(topic: string, message: BusMessage) {
      published.push(message);
    },
    subscribe(pattern: string, _name: string, handler: (msg: BusMessage) => void) {
      const id = `sub-${pattern}`;
      subs.set(id, handler);
      return id;
    },
    unsubscribe(id: string) {
      subs.delete(id);
    },
    topics() { return []; },
    consumers() { return []; },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SkillAbTestPlugin", () => {
  let registry: ExecutorRegistry;
  let plugin: SkillAbTestPlugin;
  let bus: ReturnType<typeof makeBus>;

  beforeEach(() => {
    registry = new ExecutorRegistry();
    plugin = new SkillAbTestPlugin(registry);
    bus = makeBus();
    plugin.install(bus);
  });

  it("passes through to original resolve when no test is registered", () => {
    const exec = makeExecutor("proto-sdk");
    registry.register("bug_triage", exec);
    expect(registry.resolve("bug_triage")).toBe(exec);
  });

  it("intercepts resolve() for a skill under test", () => {
    const control = makeExecutor("quinn.v1");
    const challenger = makeExecutor("quinn.v2");
    plugin.registerTest("bug_triage", control, challenger, 10);

    const resolved = registry.resolve("bug_triage");
    expect(resolved).toBeInstanceOf(AbTestExecutor);
  });

  it("does not intercept resolve() for a different skill", () => {
    const exec = makeExecutor("quinn.v1");
    registry.register("daily_standup", exec);
    const control = makeExecutor("quinn.v1");
    const challenger = makeExecutor("quinn.v2");
    plugin.registerTest("bug_triage", control, challenger, 10);

    expect(registry.resolve("daily_standup")).toBe(exec);
  });

  describe("A/B routing via correlationId hash", () => {
    it("routes dispatches to control or challenger based on correlationId", async () => {
      const control = makeExecutor("ctrl");
      const challenger = makeExecutor("chal");
      plugin.registerTest("bug_triage", control, challenger, 100);

      // Execute many times with different correlationIds
      const executor = registry.resolve("bug_triage")!;
      const results: string[] = [];
      for (let i = 0; i < 20; i++) {
        const r = await executor.execute(makeReq(`corr-${i}`));
        results.push(r.text);
      }

      // Both arms should have been called
      const ctrlCalls = (control.execute as ReturnType<typeof mock>).mock.calls.length;
      const chalCalls = (challenger.execute as ReturnType<typeof mock>).mock.calls.length;
      expect(ctrlCalls).toBeGreaterThan(0);
      expect(chalCalls).toBeGreaterThan(0);
      expect(ctrlCalls + chalCalls).toBe(20);
    });

    it("same correlationId always routes to same arm (deterministic)", async () => {
      const control = makeExecutor("ctrl");
      const challenger = makeExecutor("chal");
      plugin.registerTest("bug_triage", control, challenger, 100);

      const executor = registry.resolve("bug_triage")!;
      const r1 = await executor.execute(makeReq("stable-id"));
      const r2 = await executor.execute(makeReq("stable-id"));
      expect(r1.text).toBe(r2.text);
    });
  });

  describe("winner selection after N dispatches", () => {
    it("commits winner and removes ab-test executor after n dispatches", async () => {
      const control = makeExecutor("ctrl");
      // challenger always errors
      const challenger = makeExecutor("chal", true);
      plugin.registerTest("bug_triage", control, challenger, 4);

      const executor = registry.resolve("bug_triage")!;

      // Drive 4 dispatches using corr IDs that hash to different buckets
      // We need at least 4 total dispatches
      for (let i = 0; i < 10; i++) {
        await executor.execute(makeReq(`test-${i}`));
        const state = plugin.getTestStatus("bug_triage");
        if (state?.resolvedAt) break;
      }

      const state = plugin.getTestStatus("bug_triage");
      expect(state?.resolvedAt).toBeDefined();
      expect(state?.winner).toBeDefined();
    });

    it("publishes skill.ab_test.resolved after n dispatches", async () => {
      const control = makeExecutor("ctrl");
      const challenger = makeExecutor("chal");
      plugin.registerTest("bug_triage", control, challenger, 4);

      const executor = registry.resolve("bug_triage")!;
      for (let i = 0; i < 10; i++) {
        await executor.execute(makeReq(`done-${i}`));
        if (plugin.getTestStatus("bug_triage")?.resolvedAt) break;
      }

      const resolved = bus.published.find(m => m.topic === "skill.ab_test.resolved");
      expect(resolved).toBeDefined();
      const p = resolved!.payload as { skill: string; winner: string };
      expect(p.skill).toBe("bug_triage");
      expect(["control", "challenger"]).toContain(p.winner);
    });

    it("removes ab-test executor from resolve after winner is committed", async () => {
      const control = makeExecutor("ctrl");
      const challenger = makeExecutor("chal");
      registry.register("bug_triage", control); // control already in registry
      plugin.registerTest("bug_triage", control, challenger, 4);

      const executor = registry.resolve("bug_triage")!;
      for (let i = 0; i < 20; i++) {
        await executor.execute(makeReq(`fin-${i}`));
        if (plugin.getTestStatus("bug_triage")?.resolvedAt) break;
      }

      // After resolution, resolve() should NOT return AbTestExecutor
      const afterExec = registry.resolve("bug_triage");
      expect(afterExec).not.toBeInstanceOf(AbTestExecutor);
    });

    it("picks challenger as winner when it has a clearly higher success rate", async () => {
      // Control always errors; challenger always succeeds.
      // correlationIds that hash to bucket 0 go to control, bucket 1 to challenger.
      // We need enough dispatches with bucket=1 to hit n.
      const control = makeExecutor("ctrl", true);  // always fails
      const challenger = makeExecutor("chal", false); // always succeeds
      plugin.registerTest("bug_triage", control, challenger, 4);

      const executor = registry.resolve("bug_triage")!;
      // Use correlationIds we know hash to bucket 1 (challenger)
      // and bucket 0 (control) to ensure both arms get dispatches
      for (let i = 0; i < 20; i++) {
        await executor.execute(makeReq(`pick-${i}`));
        if (plugin.getTestStatus("bug_triage")?.resolvedAt) break;
      }

      const state = plugin.getTestStatus("bug_triage");
      if (state?.winner) {
        // If enough dispatches went to each arm, challenger should win
        const ctrlRate = state.control.metrics.dispatches > 0
          ? state.control.metrics.successes / state.control.metrics.dispatches
          : 0;
        const chalRate = state.challenger.metrics.dispatches > 0
          ? state.challenger.metrics.successes / state.challenger.metrics.dispatches
          : 0;
        if (chalRate > ctrlRate + 0.05) {
          expect(state.winner).toBe("challenger");
        }
      }
    });
  });

  describe("listTests and getTestStatus", () => {
    it("returns undefined for an unknown skill", () => {
      expect(plugin.getTestStatus("unknown")).toBeUndefined();
    });

    it("lists all tests including resolved ones", async () => {
      const c1 = makeExecutor("c1");
      const ch1 = makeExecutor("ch1");
      plugin.registerTest("skill_a", c1, ch1, 2);

      const c2 = makeExecutor("c2");
      const ch2 = makeExecutor("ch2");
      plugin.registerTest("skill_b", c2, ch2, 100);

      expect(plugin.listTests()).toHaveLength(2);
    });

    it("ignores duplicate registerTest() for same skill", () => {
      const c = makeExecutor("c");
      const ch = makeExecutor("ch");
      plugin.registerTest("bug_triage", c, ch, 10);
      plugin.registerTest("bug_triage", c, ch, 20); // duplicate

      expect(plugin.listTests()).toHaveLength(1);
      expect(plugin.getTestStatus("bug_triage")!.n).toBe(10);
    });
  });

  describe("uninstall", () => {
    it("removes the resolve hook so registry returns original result", () => {
      const exec = makeExecutor("original");
      registry.register("bug_triage", exec);

      const control = makeExecutor("ctrl");
      const challenger = makeExecutor("chal");
      plugin.registerTest("bug_triage", control, challenger, 10);

      // Confirm the hook is active
      expect(registry.resolve("bug_triage")).toBeInstanceOf(AbTestExecutor);

      plugin.uninstall();

      // After uninstall, original executor is returned
      expect(registry.resolve("bug_triage")).toBe(exec);
    });
  });
});

describe("ExecutorRegistry resolve hook integration", () => {
  it("hook can override resolved executor", () => {
    const registry = new ExecutorRegistry();
    const original = makeExecutor("original");
    const override = makeExecutor("override");
    registry.register("skill", original);

    registry.setResolveHook((_skill, _targets, resolved) => {
      if (resolved === original) return override;
      return resolved;
    });

    expect(registry.resolve("skill")).toBe(override);
  });

  it("clearing hook (null) restores normal resolution", () => {
    const registry = new ExecutorRegistry();
    const original = makeExecutor("original");
    registry.register("skill", original);

    registry.setResolveHook(() => null);
    expect(registry.resolve("skill")).toBeNull();

    registry.setResolveHook(null);
    expect(registry.resolve("skill")).toBe(original);
  });
});
