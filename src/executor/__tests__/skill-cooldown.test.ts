import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cooldownKeyFor, cooldownMsFor } from "../skill-dispatcher-plugin.ts";

describe("cooldownMsFor", () => {
  const ENV_KEYS = [
    "WORKSTACEAN_COOLDOWN_MS_BUG_TRIAGE",
    "WORKSTACEAN_COOLDOWN_MS_PR_REVIEW",
    "WORKSTACEAN_COOLDOWN_MS_SECURITY_TRIAGE",
    "WORKSTACEAN_COOLDOWN_MS_MY_NEW_SKILL",
  ];
  const snapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) snapshot[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
    }
  });

  test("returns defaults for built-in skills", () => {
    expect(cooldownMsFor("bug_triage")).toBe(30_000);
    expect(cooldownMsFor("pr_review")).toBe(30_000);
    expect(cooldownMsFor("security_triage")).toBe(60_000);
  });

  test("returns 0 for unknown skills (no cooldown)", () => {
    expect(cooldownMsFor("nonexistent_skill")).toBe(0);
    expect(cooldownMsFor("")).toBe(0);
  });

  test("env override wins over default", () => {
    process.env["WORKSTACEAN_COOLDOWN_MS_BUG_TRIAGE"] = "5000";
    expect(cooldownMsFor("bug_triage")).toBe(5000);
  });

  test("env override can set cooldown for skill that has no default", () => {
    process.env["WORKSTACEAN_COOLDOWN_MS_MY_NEW_SKILL"] = "12345";
    expect(cooldownMsFor("my_new_skill")).toBe(12345);
  });

  test("env override of 0 disables cooldown", () => {
    process.env["WORKSTACEAN_COOLDOWN_MS_BUG_TRIAGE"] = "0";
    expect(cooldownMsFor("bug_triage")).toBe(0);
  });

  test("garbage env value falls back to default", () => {
    process.env["WORKSTACEAN_COOLDOWN_MS_PR_REVIEW"] = "not-a-number";
    expect(cooldownMsFor("pr_review")).toBe(30_000);
    process.env["WORKSTACEAN_COOLDOWN_MS_PR_REVIEW"] = "-1";
    expect(cooldownMsFor("pr_review")).toBe(30_000);
  });
});

describe("cooldownKeyFor", () => {
  test("includes #number when github.number present", () => {
    const payload = { github: { owner: "protoLabsAI", repo: "protoMaker", number: 100 } };
    expect(cooldownKeyFor("bug_triage", payload)).toBe("bug_triage:protoLabsAI/protoMaker#100");
  });

  test("repo-only when no number", () => {
    const payload = { github: { owner: "protoLabsAI", repo: "protoMaker" } };
    expect(cooldownKeyFor("security_triage", payload)).toBe("security_triage:protoLabsAI/protoMaker");
  });

  test("includes @sha7 when github.headSha present (PR review case)", () => {
    const payload = {
      github: {
        owner: "protoLabsAI",
        repo: "protoMaker",
        number: 200,
        headSha: "abc1234567890def",
      },
    };
    expect(cooldownKeyFor("pr_review", payload)).toBe("pr_review:protoLabsAI/protoMaker#200@abc1234");
  });

  test("new commit on same PR gets a different key (the #86 fix point)", () => {
    const before = cooldownKeyFor("pr_review", { github: { owner: "x", repo: "y", number: 1, headSha: "aaaaaaaaaaaa" } });
    const after = cooldownKeyFor("pr_review", { github: { owner: "x", repo: "y", number: 1, headSha: "bbbbbbbbbbbb" } });
    expect(before).not.toBe(after);
  });

  test("different PRs in the same repo get separate keys", () => {
    const pr1 = cooldownKeyFor("pr_review", { github: { owner: "x", repo: "y", number: 1, headSha: "aaa" } });
    const pr2 = cooldownKeyFor("pr_review", { github: { owner: "x", repo: "y", number: 2, headSha: "bbb" } });
    expect(pr1).not.toBe(pr2);
  });

  test("repeated webhooks for same PR + same SHA share a key (dedup intact)", () => {
    const a = cooldownKeyFor("pr_review", { github: { owner: "x", repo: "y", number: 5, headSha: "deadbeef1234" } });
    const b = cooldownKeyFor("pr_review", { github: { owner: "x", repo: "y", number: 5, headSha: "deadbeef1234" } });
    expect(a).toBe(b);
  });

  test("different repos get separate buckets (the #556 fix point — preserved)", () => {
    const a = cooldownKeyFor("bug_triage", { github: { owner: "protoLabsAI", repo: "protoMaker" } });
    const b = cooldownKeyFor("bug_triage", { github: { owner: "protoLabsAI", repo: "protoWorkstacean" } });
    expect(a).not.toBe(b);
  });

  test("different skills on the same repo get separate buckets", () => {
    const ctx = { github: { owner: "x", repo: "y" } };
    expect(cooldownKeyFor("bug_triage", ctx)).not.toBe(cooldownKeyFor("pr_review", ctx));
  });

  test("different issues in the same repo get separate buckets (no more cross-issue back-pressure)", () => {
    const issue1 = cooldownKeyFor("bug_triage", { github: { owner: "x", repo: "y", number: 100 } });
    const issue2 = cooldownKeyFor("bug_triage", { github: { owner: "x", repo: "y", number: 101 } });
    expect(issue1).not.toBe(issue2);
  });

  test("falls back to <skill>:_ when no github context", () => {
    expect(cooldownKeyFor("bug_triage", undefined)).toBe("bug_triage:_");
    expect(cooldownKeyFor("bug_triage", {})).toBe("bug_triage:_");
    expect(cooldownKeyFor("bug_triage", { github: {} })).toBe("bug_triage:_");
    expect(cooldownKeyFor("bug_triage", { github: { owner: "x" /* no repo */ } })).toBe("bug_triage:_");
  });

  test("ignores non-string owner/repo (defensive against bad payloads)", () => {
    expect(cooldownKeyFor("x", { github: { owner: 42, repo: ["y"] } })).toBe("x:_");
  });
});
