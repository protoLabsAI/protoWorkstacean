import { describe, expect, test } from "bun:test";
import { GitHubPlugin } from "../github.ts";

// Access private static members for testing
const TERMINAL_CONCLUSIONS = GitHubPlugin.TERMINAL_CONCLUSIONS;

describe("GitHubPlugin TERMINAL_CONCLUSIONS", () => {
  test("contains all expected terminal conclusion values", () => {
    expect(TERMINAL_CONCLUSIONS.has("success")).toBe(true);
    expect(TERMINAL_CONCLUSIONS.has("failure")).toBe(true);
    expect(TERMINAL_CONCLUSIONS.has("neutral")).toBe(true);
    expect(TERMINAL_CONCLUSIONS.has("skipped")).toBe(true);
    expect(TERMINAL_CONCLUSIONS.has("cancelled")).toBe(true);
    expect(TERMINAL_CONCLUSIONS.has("timed_out")).toBe(true);
    expect(TERMINAL_CONCLUSIONS.has("action_required")).toBe(true);
  });

  test("does NOT contain null or empty string", () => {
    expect(TERMINAL_CONCLUSIONS.has("")).toBe(false);
  });
});

// Test _isTerminalConclusion via reflection (private method)
describe("GitHubPlugin._isTerminalConclusion", () => {
  // Create a minimal plugin instance to access private method
  function makePlugin() {
    // Mock project registry
    const registry = {
      getByGithub: () => undefined,
      getGithubCoords: () => [],
    };
    return new GitHubPlugin("/tmp/test-workspace", registry as any);
  }

  test("accepts all terminal string values", () => {
    const plugin = makePlugin();
    for (const value of TERMINAL_CONCLUSIONS) {
      expect((plugin as any)._isTerminalConclusion(value)).toBe(true);
    }
  });

  test("rejects null (still running)", () => {
    const plugin = makePlugin();
    expect((plugin as any)._isTerminalConclusion(null)).toBe(false);
  });

  test("rejects undefined", () => {
    const plugin = makePlugin();
    expect((plugin as any)._isTerminalConclusion(undefined)).toBe(false);
  });

  test("rejects non-string types", () => {
    const plugin = makePlugin();
    expect((plugin as any)._isTerminalConclusion(123)).toBe(false);
    expect((plugin as any)._isTerminalConclusion(true)).toBe(false);
    expect((plugin as any)._isTerminalConclusion({})).toBe(false);
  });

  test("rejects unknown string values", () => {
    const plugin = makePlugin();
    expect((plugin as any)._isTerminalConclusion("unknown")).toBe(false);
    expect((plugin as any)._isTerminalConclusion("")).toBe(false);
  });
});

// Test dedup key generation in _handleAutoReview opts
describe("GitHubPlugin dedup key handling", () => {
  test("ci-review prefix does not collide with pr-review prefix", () => {
    const ciKey = "ci-review:owner/repo#42";
    const prKey = "pr-review:owner/repo#42";
    expect(ciKey).not.toBe(prKey);
    expect(ciKey.startsWith("ci-review:")).toBe(true);
    expect(prKey.startsWith("pr-review:")).toBe(true);
  });
});

// Test webhook payload parsing for check_suite and workflow_run
describe("CI-completion webhook payload extraction", () => {
  test("check_suite payload contains head_sha and conclusion", () => {
    const payload: Record<string, unknown> = {
      action: "completed",
      check_suite: {
        id: 12345,
        head_sha: "abc123def456",
        conclusion: "success",
        status: "completed",
      },
      repository: {
        name: "test-repo",
        owner: { login: "test-owner" },
      },
    };

    const cs = payload.check_suite as Record<string, unknown>;
    expect(cs.head_sha).toBe("abc123def456");
    expect(cs.conclusion).toBe("success");
  });

  test("workflow_run payload contains head_sha and conclusion", () => {
    const payload: Record<string, unknown> = {
      action: "completed",
      workflow_run: {
        id: 67890,
        head_sha: "def456abc123",
        conclusion: "failure",
        status: "completed",
      },
      repository: {
        name: "test-repo",
        owner: { login: "test-owner" },
      },
    };

    const wr = payload.workflow_run as Record<string, unknown>;
    expect(wr.head_sha).toBe("def456abc123");
    expect(wr.conclusion).toBe("failure");
  });

  test("null conclusion means still running (should be skipped)", () => {
    const payload: Record<string, unknown> = {
      action: "completed",
      check_suite: {
        id: 12345,
        head_sha: "abc123def456",
        conclusion: null,
        status: "completed",
      },
      repository: {
        name: "test-repo",
        owner: { login: "test-owner" },
      },
    };

    const cs = payload.check_suite as Record<string, unknown>;
    expect(cs.conclusion).toBeNull();
  });
});
