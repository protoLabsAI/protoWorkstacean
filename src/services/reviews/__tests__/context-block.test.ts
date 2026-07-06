import { describe, expect, test } from "bun:test";
import { formatCodebaseContext, type CodebaseContext } from "../context-formatter.ts";
import { applyTokenBudget } from "../token-budgeter.ts";
import type { PastPRDecision } from "../../qdrant/past-pr-retriever.ts";
import type { SimilarPattern } from "../../qdrant/pattern-searcher.ts";

function decision(prNumber: number, file: string, issues = ""): PastPRDecision {
  return {
    prNumber,
    prUrl: `https://github.com/o/r/pull/${prNumber}`,
    decision: "APPROVE",
    mergedAt: "2026-07-01T00:00:00Z",
    reviewIssues: issues,
    file,
    score: 0.9,
  };
}

function pattern(symbol: string, file: string, score: number, context = "const x = 1;"): SimilarPattern {
  return { repo: "o/r", file, symbolName: symbol, symbolType: "function", line: 10, context, score };
}

describe("formatCodebaseContext", () => {
  test("renders decisions and patterns into one block", () => {
    const ctx: CodebaseContext = {
      pastDecisions: new Map([["src/a.ts", [decision(42, "src/a.ts", "missing null check")]]]),
      similarPatterns: new Map([["foo:src/b.ts", [pattern("foo", "src/c.ts", 0.8)]]]),
    };
    const block = formatCodebaseContext(ctx);
    expect(block).toStartWith("CODEBASE CONTEXT:");
    expect(block).toContain("PR #42 (2026-07-01): APPROVE — missing null check");
    expect(block).toContain("`foo` in src/c.ts:10 (o/r)");
  });

  test("empty context renders to empty string", () => {
    expect(formatCodebaseContext({ pastDecisions: new Map(), similarPatterns: new Map() })).toBe("");
  });
});

describe("applyTokenBudget", () => {
  test("trims lowest-scored patterns first and preserves decisions", () => {
    const bigContext = "x".repeat(2_000);
    const ctx: CodebaseContext = {
      pastDecisions: new Map([["src/a.ts", [decision(1, "src/a.ts")]]]),
      similarPatterns: new Map([
        ["keep:f", [pattern("keep", "src/k.ts", 0.99, bigContext)]],
        ["drop:f", [pattern("drop", "src/d.ts", 0.01, bigContext)]],
      ]),
    };
    // 20% of 1000 tokens = 200 tokens ≈ 800 chars — forces trimming.
    const budgeted = applyTokenBudget(ctx, 1_000);
    expect(budgeted.pastDecisions.size).toBe(1);
    const remaining = [...budgeted.similarPatterns.values()].flat().map((p) => p.symbolName);
    expect(remaining).not.toContain("drop");
  });
});
