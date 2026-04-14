import { describe, it, expect, mock } from "bun:test";
import { ExecutorRegistry } from "../executor-registry.ts";
import type { IExecutor, SkillRequest, SkillResult } from "../types.ts";

function makeExecutor(type: string): IExecutor {
  return {
    type,
    execute: mock(async (_req: SkillRequest): Promise<SkillResult> => ({
      text: `result from ${type}`,
      isError: false,
      correlationId: _req.correlationId,
    })),
  };
}

const REQ: SkillRequest = {
  skill: "daily_standup",
  correlationId: "trace-abc",
  replyTopic: "agent.skill.response.1",
  payload: {},
};

describe("ExecutorRegistry", () => {
  describe("register + resolve — skill match", () => {
    it("resolves registered skill", () => {
      const registry = new ExecutorRegistry();
      const exec = makeExecutor("proto-sdk");
      registry.register("daily_standup", exec);
      expect(registry.resolve("daily_standup")).toBe(exec);
    });

    it("returns null for unknown skill with no default", () => {
      const registry = new ExecutorRegistry();
      expect(registry.resolve("unknown_skill")).toBeNull();
    });

    it("falls back to default when skill not registered", () => {
      const registry = new ExecutorRegistry();
      const def = makeExecutor("a2a");
      registry.registerDefault(def);
      expect(registry.resolve("unknown_skill")).toBe(def);
    });

    it("prefers skill match over default", () => {
      const registry = new ExecutorRegistry();
      const specific = makeExecutor("proto-sdk");
      const fallback = makeExecutor("a2a");
      registry.register("daily_standup", specific);
      registry.registerDefault(fallback);
      expect(registry.resolve("daily_standup")).toBe(specific);
    });
  });

  describe("priority", () => {
    it("higher priority wins for same skill", () => {
      const registry = new ExecutorRegistry();
      const low = makeExecutor("low");
      const high = makeExecutor("high");
      registry.register("standup", low, { priority: 0 });
      registry.register("standup", high, { priority: 10 });
      expect(registry.resolve("standup")).toBe(high);
    });
  });

  describe("target-based resolution", () => {
    it("resolves by agent name in targets", () => {
      const registry = new ExecutorRegistry();
      const ava = makeExecutor("a2a-ava");
      const quinn = makeExecutor("a2a-quinn");
      registry.register("some_skill", ava, { agentName: "ava" });
      registry.register("some_skill", quinn, { agentName: "quinn" });
      expect(registry.resolve("some_skill", ["quinn"])).toBe(quinn);
    });

    it("target takes precedence over skill priority", () => {
      const registry = new ExecutorRegistry();
      const highPriority = makeExecutor("high-priority");
      const targetMatch = makeExecutor("target-match");
      registry.register("skill", highPriority, { priority: 100 });
      registry.register("skill", targetMatch, { agentName: "ava", priority: 0 });
      expect(registry.resolve("skill", ["ava"])).toBe(targetMatch);
    });

    it("falls through to skill match when target not found", () => {
      const registry = new ExecutorRegistry();
      const exec = makeExecutor("proto-sdk");
      registry.register("skill", exec);
      expect(registry.resolve("skill", ["nonexistent-agent"])).toBe(exec);
    });
  });

  describe("registerDefault", () => {
    it("last registerDefault call wins", () => {
      const registry = new ExecutorRegistry();
      const first = makeExecutor("first");
      const second = makeExecutor("second");
      registry.registerDefault(first);
      registry.registerDefault(second);
      expect(registry.resolve("any")).toBe(second);
    });
  });

  describe("registerEffect + resolveByEffect", () => {
    it("returns candidates for a registered (domain, path)", () => {
      const registry = new ExecutorRegistry();
      registry.registerEffect("fix_ci", "ava", [
        { domain: "ci", path: "data.blockedPRs", expectedDelta: -1, confidence: 0.9 },
      ]);
      const results = registry.resolveByEffect({ domain: "ci", path: "data.blockedPRs" });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        skill: "fix_ci",
        agentName: "ava",
        domain: "ci",
        path: "data.blockedPRs",
        expectedDelta: -1,
        confidence: 0.9,
      });
    });

    it("returns empty array when no match", () => {
      const registry = new ExecutorRegistry();
      expect(registry.resolveByEffect({ domain: "ci", path: "data.blockedPRs" })).toEqual([]);
    });

    it("accumulates multiple skills for the same (domain, path)", () => {
      const registry = new ExecutorRegistry();
      registry.registerEffect("fix_ci", "ava", [
        { domain: "ci", path: "data.blockedPRs", expectedDelta: -1, confidence: 0.9 },
      ]);
      registry.registerEffect("triage_ci", "quinn", [
        { domain: "ci", path: "data.blockedPRs", expectedDelta: -2, confidence: 0.6 },
      ]);
      const results = registry.resolveByEffect({ domain: "ci", path: "data.blockedPRs" });
      expect(results).toHaveLength(2);
      expect(results.map(r => r.skill)).toEqual(["fix_ci", "triage_ci"]);
    });

    it("a single registerEffect call with multiple effects populates all keys", () => {
      const registry = new ExecutorRegistry();
      registry.registerEffect("deploy", undefined, [
        { domain: "ci", path: "data.failCount", expectedDelta: -1, confidence: 0.8 },
        { domain: "plane", path: "data.openIssues", expectedDelta: -1, confidence: 0.7 },
      ]);
      expect(registry.resolveByEffect({ domain: "ci", path: "data.failCount" })).toHaveLength(1);
      expect(registry.resolveByEffect({ domain: "plane", path: "data.openIssues" })).toHaveLength(1);
    });

    it("resolveByEffect returns a copy — mutations do not affect internal state", () => {
      const registry = new ExecutorRegistry();
      registry.registerEffect("fix_ci", undefined, [
        { domain: "ci", path: "data.blockedPRs", expectedDelta: -1, confidence: 0.9 },
      ]);
      const results = registry.resolveByEffect({ domain: "ci", path: "data.blockedPRs" });
      results.pop();
      expect(registry.resolveByEffect({ domain: "ci", path: "data.blockedPRs" })).toHaveLength(1);
    });

    it("does not affect existing resolve() behaviour", () => {
      const registry = new ExecutorRegistry();
      const exec = makeExecutor("proto-sdk");
      registry.register("fix_ci", exec);
      registry.registerEffect("fix_ci", undefined, [
        { domain: "ci", path: "data.blockedPRs", expectedDelta: -1, confidence: 0.9 },
      ]);
      expect(registry.resolve("fix_ci")).toBe(exec);
    });
  });

  describe("list + size", () => {
    it("tracks all registrations", () => {
      const registry = new ExecutorRegistry();
      registry.register("skill_a", makeExecutor("a"));
      registry.register("skill_b", makeExecutor("b"));
      registry.register("skill_a", makeExecutor("a2"), { priority: 5 });
      expect(registry.size).toBe(3);
      expect(registry.list()).toHaveLength(3);
    });

    it("list returns a copy", () => {
      const registry = new ExecutorRegistry();
      registry.register("s", makeExecutor("x"));
      const list = registry.list();
      list.pop();
      expect(registry.size).toBe(1);
    });
  });
});
