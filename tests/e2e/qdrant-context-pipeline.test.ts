/**
 * E2E test for the Qdrant context pipeline.
 *
 * Tests the complete flow without live Qdrant/Ollama (uses mocked fetch).
 * Verifies: diff parsing → symbol extraction → context formatting → prompt assembly.
 */

import { describe, test, expect, beforeAll, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── Load fixture ───────────────────────────────────────────────────────────────

const fixtureDir = join(import.meta.dir, "../fixtures");
const samplePR = JSON.parse(readFileSync(join(fixtureDir, "sample-pr-diff.json"), "utf8"));

// ── Import pipeline modules ────────────────────────────────────────────────────

import { parseDiff, chunkDiff } from "../../src/services/diff/chunker.ts";
import { extractAllSymbols } from "../../src/services/diff/symbol-extractor.ts";
import { formatCodebaseContext } from "../../src/services/reviews/context-formatter.ts";
import { assembleReviewPrompt } from "../../src/services/reviews/quinn-review-prompt.ts";
import { applyTokenBudget, estimateTokens } from "../../src/services/reviews/token-budgeter.ts";
import { isDismissalResponse } from "../../src/services/reviews/dismissal-tracker.ts";
import { parsePRMergePayload } from "../../src/webhooks/github-pr-merge.ts";
import { parseCommentResponsePayload } from "../../src/webhooks/github-comment-response.ts";
import { summarizeReviewIssues } from "../../src/services/github/diff-fetcher.ts";

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("Diff Parser", () => {
  test("parses sample diff into files", () => {
    const files = parseDiff(samplePR.diff);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0].path).toBe("src/middleware/auth.ts");
  });

  test("extracts added lines from hunks", () => {
    const files = parseDiff(samplePR.diff);
    const authFile = files.find(f => f.path === "src/middleware/auth.ts");
    expect(authFile).toBeDefined();
    expect(authFile!.added.length).toBeGreaterThan(0);
  });

  test("chunks small diff files as single chunk", () => {
    const files = parseDiff(samplePR.diff);
    const chunks = chunkDiff(files);
    expect(chunks.length).toBeGreaterThan(0);
    // All chunks in sample diff should be single chunks (small files)
    const authChunks = chunks.filter(c => c.filePath === "src/middleware/auth.ts");
    expect(authChunks.length).toBe(1);
    expect(authChunks[0].chunkIndex).toBe(0);
  });
});

describe("Symbol Extractor", () => {
  test("extracts TypeScript symbols from diff", () => {
    const files = parseDiff(samplePR.diff);
    const symbols = extractAllSymbols(files);
    expect(symbols.length).toBeGreaterThan(0);

    const names = symbols.map(s => s.name);
    // Should find validateToken function and AuthMiddleware class and AuthToken interface
    expect(names).toContain("validateToken");
    expect(names).toContain("AuthMiddleware");
  });

  test("assigns correct language to TypeScript files", () => {
    const files = parseDiff(samplePR.diff);
    const symbols = extractAllSymbols(files);
    for (const sym of symbols) {
      expect(sym.language).toBe("typescript");
    }
  });

  test("skips unsupported file extensions", () => {
    const files = [
      {
        path: "config/settings.toml",
        hunks: [{ header: "@@ -0,0 +1,3 @@", lines: ["+[server]", "+port = 8080"], startLine: 1, endLine: 3 }],
        added: ["[server]", "port = 8080"],
        removed: [],
      },
    ];
    const symbols = extractAllSymbols(files);
    expect(symbols.length).toBe(0);
  });
});

describe("Context Formatter", () => {
  test("formats CODEBASE CONTEXT block with past PR decisions", () => {
    const ctx = {
      pastDecisions: new Map([
        ["src/middleware/auth.ts", [
          {
            prNumber: 142,
            prUrl: "https://github.com/protolabsai/protomaker/pull/142",
            decision: "APPROVE",
            mergedAt: "2026-04-01T12:00:00Z",
            reviewIssues: "Token expiry not checked",
            file: "src/middleware/auth.ts",
            score: 0.92,
          },
        ]],
      ]),
      similarPatterns: new Map(),
    };

    const block = formatCodebaseContext(ctx);
    expect(block).toContain("CODEBASE CONTEXT:");
    expect(block).toContain("PR #142");
    expect(block).toContain("APPROVE");
    expect(block).toContain("Token expiry not checked");
  });

  test("returns empty string when no context", () => {
    const ctx = {
      pastDecisions: new Map(),
      similarPatterns: new Map(),
    };
    const block = formatCodebaseContext(ctx);
    expect(block).toBe("");
  });

  test("formats similar patterns section", () => {
    const ctx = {
      pastDecisions: new Map(),
      similarPatterns: new Map([
        ["validateToken:src/middleware/auth.ts", [
          {
            repo: "protolabsai/protomaker",
            file: "src/utils/jwt.ts",
            symbolName: "validateToken",
            symbolType: "function",
            line: 23,
            context: "23: export function validateToken(token: string): boolean {\n24:   // ...\n25: }",
            score: 0.87,
          },
        ]],
      ]),
    };

    const block = formatCodebaseContext(ctx);
    expect(block).toContain("CODEBASE CONTEXT:");
    expect(block).toContain("validateToken");
    expect(block).toContain("src/utils/jwt.ts:23");
  });
});

describe("Token Budgeter", () => {
  test("estimates token count from text", () => {
    const tokens = estimateTokens("Hello world"); // 11 chars / 4 = 3 tokens
    expect(tokens).toBeGreaterThan(0);
  });

  test("respects 20% budget cap", () => {
    const manyPatterns = new Map<string, Array<{ repo: string; file: string; symbolName: string; symbolType: string; line: number; context: string; score: number }>>();
    // Add 20 patterns to exceed budget
    for (let i = 0; i < 20; i++) {
      manyPatterns.set(`symbol${i}:file${i}.ts`, [{
        repo: "test/repo",
        file: `src/file${i}.ts`,
        symbolName: `symbol${i}`,
        symbolType: "function",
        line: i * 10,
        context: "A".repeat(500), // 500 chars each
        score: 0.9 - i * 0.01,
      }]);
    }

    const ctx = {
      pastDecisions: new Map(),
      similarPatterns: manyPatterns,
    };

    // Small budget of 1000 tokens = 200 tokens for context
    const budgeted = applyTokenBudget(ctx, 1000);

    // Verify that patterns were trimmed
    const totalPatterns = [...budgeted.similarPatterns.values()].reduce((acc, p) => acc + p.length, 0);
    expect(totalPatterns).toBeLessThan(20);
  });
});

describe("Review Prompt Assembler", () => {
  test("assembles prompt with diff", () => {
    const result = assembleReviewPrompt({
      diff: samplePR.diff,
      repo: samplePR.repo,
      prNumber: samplePR.prNumber,
      prUrl: samplePR.prUrl,
      title: samplePR.title,
    });

    expect(result.prompt).toContain("src/middleware/auth.ts");
    expect(result.prompt).toContain(`PR #${samplePR.prNumber}`);
    expect(result.hasContext).toBe(false);
    expect(result.diffTokens).toBeGreaterThan(0);
  });

  test("prepends CODEBASE CONTEXT block when context provided", () => {
    const ctx = {
      pastDecisions: new Map([
        ["src/middleware/auth.ts", [
          {
            prNumber: 100,
            prUrl: "https://github.com/test/repo/pull/100",
            decision: "REQUEST_CHANGES",
            mergedAt: "2026-03-01T10:00:00Z",
            reviewIssues: "Missing error handling",
            file: "src/middleware/auth.ts",
            score: 0.91,
          },
        ]],
      ]),
      similarPatterns: new Map(),
    };

    const result = assembleReviewPrompt({
      diff: samplePR.diff,
      repo: samplePR.repo,
      prNumber: samplePR.prNumber,
      prUrl: samplePR.prUrl,
      title: samplePR.title,
      context: ctx,
    });

    expect(result.hasContext).toBe(true);
    expect(result.prompt).toContain("CODEBASE CONTEXT:");
    expect(result.contextTokens).toBeGreaterThan(0);
    // Context should appear before the diff
    const contextIdx = result.prompt.indexOf("CODEBASE CONTEXT:");
    const diffIdx = result.prompt.indexOf("diff --git");
    expect(contextIdx).toBeLessThan(diffIdx);
  });
});

describe("Dismissal Tracker", () => {
  test("detects dismissal phrases", () => {
    expect(isDismissalResponse("this is fine, by design")).toBe(true);
    expect(isDismissalResponse("won't fix — we handle this upstream")).toBe(true);
    expect(isDismissalResponse("false positive")).toBe(true);
    expect(isDismissalResponse("great catch, fixing now")).toBe(false);
    expect(isDismissalResponse("thanks for the review")).toBe(false);
  });
});

describe("PR Merge Webhook Parser", () => {
  test("accepts merged PR close event", () => {
    const payload = {
      action: "closed",
      pull_request: {
        number: 42,
        merged: true,
        merged_at: "2026-04-01T12:00:00Z",
        html_url: "https://github.com/test/repo/pull/42",
        title: "feat: add feature",
        base: { ref: "main", sha: "abc123" },
        head: { sha: "def456" },
      },
      repository: {
        name: "repo",
        owner: { login: "test" },
      },
    };
    const result = parsePRMergePayload("pull_request", payload);
    expect(result).not.toBeNull();
    expect(result!.pull_request.number).toBe(42);
  });

  test("rejects unmerged PR close event", () => {
    const payload = {
      action: "closed",
      pull_request: { number: 42, merged: false, merged_at: null },
      repository: { name: "repo", owner: { login: "test" } },
    };
    const result = parsePRMergePayload("pull_request", payload);
    expect(result).toBeNull();
  });

  test("rejects non-PR events", () => {
    const result = parsePRMergePayload("push", {});
    expect(result).toBeNull();
  });
});

describe("Review Comments Summary", () => {
  test("summarizes Quinn comments into review issues string", () => {
    const comments = samplePR.reviewComments;
    const summary = summarizeReviewIssues(comments);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain("Token expiry");
  });
});

describe("Comment Response Webhook Parser", () => {
  test("identifies comment reply events", () => {
    const payload = {
      action: "created",
      comment: {
        body: "this is by design",
        path: "src/auth.ts",
        in_reply_to_id: 12345,
        user: { login: "developer" },
      },
      pull_request: { number: 10 },
      repository: { name: "repo", owner: { login: "test" } },
    };
    const result = parseCommentResponsePayload("pull_request_review_comment", payload);
    expect(result.type).toBe("comment_response");
  });

  test("identifies review dismissal events", () => {
    const payload = {
      action: "dismissed",
      review: {
        body: null,
        state: "dismissed",
        user: { login: "protoquinn[bot]" },
        dismissed_review: { dismissal_message: "not applicable" },
      },
      pull_request: { number: 10 },
      repository: { name: "repo", owner: { login: "test" } },
    };
    const result = parseCommentResponsePayload("pull_request_review", payload);
    expect(result.type).toBe("review_dismissal");
  });
});
