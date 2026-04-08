/**
 * Tests for the plan learning flywheel — rule extraction, registry, and promotion.
 */

import { describe, test, expect } from "bun:test";
import type { Action, Plan, PlannerState } from "../../src/planner/types.ts";
import type { L2Result } from "../../src/planner/routing-interface.ts";
import { RuleRegistry } from "../../src/learning/rule-registry.ts";
import { RuleExtractor } from "../../src/learning/rule-extractor.ts";
import { PlanConverter } from "../../src/learning/plan-converter.ts";
import { PatternMatcher } from "../../src/learning/pattern-matcher.ts";
import { RuleVersioning } from "../../src/learning/rule-versioning.ts";
import { RuleAuditor } from "../../src/learning/rule-auditor.ts";
import { RuleMigration } from "../../src/learning/rule-migration.ts";
import { FeedbackCollector } from "../../src/learning/feedback-collector.ts";
import { OutcomeAnalyzer } from "../../src/learning/outcome-analyzer.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAction(id: string, cost: number): Action {
  return {
    id,
    name: id,
    cost,
    level: "action" as const,
    preconditions: [(s: PlannerState) => s["ready"] === true],
    effects: [(s: PlannerState) => ({ ...s, done: true })],
  };
}

function makeL2Result(planId: string, plan: Plan, confidence: number): L2Result {
  return {
    success: true,
    plan,
    confidence: {
      overall: confidence,
      breakdown: {
        feasibility: confidence,
        goalAlignment: confidence,
        costEfficiency: confidence,
        constraintSatisfaction: confidence,
      },
    },
    escalatedToL3: false,
    planId,
  };
}

// ── RuleRegistry tests ──────────────────────────────────────────────────────

describe("RuleRegistry", () => {
  test("registers and retrieves rules", () => {
    const registry = new RuleRegistry();
    const rule = {
      id: "r1",
      name: "Test Rule",
      goalPattern: "fix-issue",
      conditions: [(s: PlannerState) => s["ready"] === true],
      actions: [makeAction("a1", 5)],
      totalCost: 5,
      successCount: 1,
      failureCount: 0,
      confidence: 0.9,
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sourcePlanId: "plan-1",
      promotedToL0: false,
      active: true,
    };

    registry.register(rule);
    expect(registry.get("r1")?.name).toBe("Test Rule");
    expect(registry.size).toBe(1);
  });

  test("finds rules by goal pattern", () => {
    const registry = new RuleRegistry();
    registry.register({
      id: "r1", name: "R1", goalPattern: "fix-issue",
      conditions: [], actions: [], totalCost: 0,
      successCount: 3, failureCount: 0, confidence: 0.9,
      version: 1, createdAt: Date.now(), updatedAt: Date.now(),
      sourcePlanId: "p1", promotedToL0: false, active: true,
    });
    registry.register({
      id: "r2", name: "R2", goalPattern: "deploy",
      conditions: [], actions: [], totalCost: 0,
      successCount: 1, failureCount: 0, confidence: 0.8,
      version: 1, createdAt: Date.now(), updatedAt: Date.now(),
      sourcePlanId: "p2", promotedToL0: false, active: true,
    });

    expect(registry.findByGoal("fix-issue")).toHaveLength(1);
    expect(registry.findByGoal("deploy")).toHaveLength(1);
    expect(registry.findByGoal("unknown")).toHaveLength(0);
  });

  test("tracks success/failure counts", () => {
    const registry = new RuleRegistry();
    registry.register({
      id: "r1", name: "R1", goalPattern: "test",
      conditions: [], actions: [], totalCost: 0,
      successCount: 0, failureCount: 0, confidence: 0.9,
      version: 1, createdAt: Date.now(), updatedAt: Date.now(),
      sourcePlanId: "p1", promotedToL0: false, active: true,
    });

    registry.recordSuccess("r1");
    registry.recordSuccess("r1");
    registry.recordFailure("r1");

    const rule = registry.get("r1")!;
    expect(rule.successCount).toBe(2);
    expect(rule.failureCount).toBe(1);
  });

  test("returns promotion candidates above threshold", () => {
    const registry = new RuleRegistry();
    registry.register({
      id: "r1", name: "R1", goalPattern: "test",
      conditions: [], actions: [], totalCost: 0,
      successCount: 5, failureCount: 0, confidence: 0.9,
      version: 1, createdAt: Date.now(), updatedAt: Date.now(),
      sourcePlanId: "p1", promotedToL0: false, active: true,
    });
    registry.register({
      id: "r2", name: "R2", goalPattern: "test2",
      conditions: [], actions: [], totalCost: 0,
      successCount: 1, failureCount: 0, confidence: 0.8,
      version: 1, createdAt: Date.now(), updatedAt: Date.now(),
      sourcePlanId: "p2", promotedToL0: false, active: true,
    });

    const candidates = registry.getPromotionCandidates(3);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe("r1");
  });

  test("deactivated rules are excluded from queries", () => {
    const registry = new RuleRegistry();
    registry.register({
      id: "r1", name: "R1", goalPattern: "test",
      conditions: [], actions: [], totalCost: 0,
      successCount: 1, failureCount: 0, confidence: 0.9,
      version: 1, createdAt: Date.now(), updatedAt: Date.now(),
      sourcePlanId: "p1", promotedToL0: false, active: true,
    });

    registry.deactivate("r1");
    expect(registry.findByGoal("test")).toHaveLength(0);
    expect(registry.getAll()).toHaveLength(0);
  });
});

// ── PlanConverter tests ─────────────────────────────────────────────────────

describe("PlanConverter", () => {
  test("converts high-confidence plan to rule", () => {
    const registry = new RuleRegistry();
    const converter = new PlanConverter(registry);

    const plan: Plan = {
      actions: [makeAction("a1", 5)],
      totalCost: 5,
      isComplete: true,
    };

    const result = makeL2Result("plan-1", plan, 0.9);
    const conversion = converter.convert(result, "fix-issue", { ready: true });

    expect(conversion.converted).toBe(true);
    expect(conversion.rule).toBeDefined();
    expect(registry.size).toBe(1);
  });

  test("rejects low-confidence plans", () => {
    const registry = new RuleRegistry();
    const converter = new PlanConverter(registry);

    const plan: Plan = {
      actions: [makeAction("a1", 5)],
      totalCost: 5,
      isComplete: true,
    };

    const result = makeL2Result("plan-1", plan, 0.3);
    const conversion = converter.convert(result, "fix-issue", { ready: true });

    expect(conversion.converted).toBe(false);
    expect(registry.size).toBe(0);
  });

  test("learning cycle returns conversion and promotion candidates", () => {
    const registry = new RuleRegistry();
    const converter = new PlanConverter(registry, { promotionThreshold: 1 });

    const plan: Plan = {
      actions: [makeAction("a1", 5)],
      totalCost: 5,
      isComplete: true,
    };

    const result = makeL2Result("plan-1", plan, 0.9);
    const cycle = converter.learningCycle(result, "fix-issue", { ready: true });

    expect(cycle.conversion.converted).toBe(true);
    expect(cycle.promotionCandidates.length).toBeGreaterThanOrEqual(1);
  });
});

// ── PatternMatcher tests ────────────────────────────────────────────────────

describe("PatternMatcher", () => {
  test("matches learned rule against state", () => {
    const registry = new RuleRegistry();
    const matcher = new PatternMatcher(registry);

    registry.register({
      id: "r1", name: "R1", goalPattern: "fix-issue",
      conditions: [(s) => s["ready"] === true],
      actions: [makeAction("a1", 5)],
      totalCost: 5,
      successCount: 3, failureCount: 0, confidence: 0.9,
      version: 1, createdAt: Date.now(), updatedAt: Date.now(),
      sourcePlanId: "p1", promotedToL0: false, active: true,
    });

    const match = matcher.match({ ready: true }, "fix-issue");
    expect(match.matched).toBe(true);
    expect(match.plan?.actions).toHaveLength(1);
    expect(match.confidence).toBeGreaterThan(0);
  });

  test("no match when conditions not met", () => {
    const registry = new RuleRegistry();
    const matcher = new PatternMatcher(registry);

    registry.register({
      id: "r1", name: "R1", goalPattern: "fix-issue",
      conditions: [(s) => s["ready"] === true],
      actions: [makeAction("a1", 5)],
      totalCost: 5,
      successCount: 3, failureCount: 0, confidence: 0.9,
      version: 1, createdAt: Date.now(), updatedAt: Date.now(),
      sourcePlanId: "p1", promotedToL0: false, active: true,
    });

    const match = matcher.match({ ready: false }, "fix-issue");
    expect(match.matched).toBe(false);
  });
});

// ── RuleMigration tests ─────────────────────────────────────────────────────

describe("RuleMigration", () => {
  test("promotes eligible rule", () => {
    const registry = new RuleRegistry();
    const versioning = new RuleVersioning();
    const auditor = new RuleAuditor();
    const migration = new RuleMigration(registry, versioning, auditor);

    registry.register({
      id: "r1", name: "R1", goalPattern: "test",
      conditions: [], actions: [], totalCost: 0,
      successCount: 5, failureCount: 0, confidence: 0.9,
      version: 1, createdAt: Date.now(), updatedAt: Date.now(),
      sourcePlanId: "p1", promotedToL0: false, active: true,
    });

    const result = migration.promote("r1");
    expect(result.success).toBe(true);
    expect(registry.get("r1")?.promotedToL0).toBe(true);
    expect(auditor.getForRule("r1")).toHaveLength(1);
  });

  test("rollback deactivates rule", () => {
    const registry = new RuleRegistry();
    const versioning = new RuleVersioning();
    const auditor = new RuleAuditor();
    const migration = new RuleMigration(registry, versioning, auditor);

    const rule = {
      id: "r1", name: "R1", goalPattern: "test",
      conditions: [], actions: [], totalCost: 0,
      successCount: 5, failureCount: 0, confidence: 0.9,
      version: 1, createdAt: Date.now(), updatedAt: Date.now(),
      sourcePlanId: "p1", promotedToL0: false, active: true,
    };

    registry.register(rule);
    versioning.createVersion(rule);
    const result = migration.rollback("r1");

    expect(result.success).toBe(true);
    expect(registry.get("r1")?.active).toBe(false);
  });
});

// ── FeedbackCollector tests ─────────────────────────────────────────────────

describe("FeedbackCollector", () => {
  test("collects and retrieves feedback", () => {
    const collector = new FeedbackCollector();

    collector.recordHumanFeedback({
      planId: "p1",
      timestamp: Date.now(),
      decision: "approve",
      decidedBy: "user-1",
    });

    collector.recordOutcome({
      planId: "p1",
      timestamp: Date.now(),
      success: true,
      durationMs: 100,
      actionOutcomes: [{ actionId: "a1", success: true }],
      goalSatisfied: true,
    });

    expect(collector.getForPlan("p1")).toHaveLength(2);
    expect(collector.getApprovedPlans()).toHaveLength(1);
    expect(collector.getSuccessfulExecutions()).toHaveLength(1);
  });
});
