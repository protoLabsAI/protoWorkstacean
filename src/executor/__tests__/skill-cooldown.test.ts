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
  test("bucketed by (skill, owner/repo) when github context present", () => {
    const payload = { github: { owner: "protoLabsAI", repo: "protoMaker", number: 100 } };
    expect(cooldownKeyFor("bug_triage", payload)).toBe("bug_triage:protoLabsAI/protoMaker");
  });

  test("different repos get separate buckets (the #556 fix point)", () => {
    const a = cooldownKeyFor("bug_triage", { github: { owner: "protoLabsAI", repo: "protoMaker" } });
    const b = cooldownKeyFor("bug_triage", { github: { owner: "protoLabsAI", repo: "protoWorkstacean" } });
    expect(a).not.toBe(b);
  });

  test("different skills on the same repo get separate buckets", () => {
    const ctx = { github: { owner: "x", repo: "y" } };
    expect(cooldownKeyFor("bug_triage", ctx)).not.toBe(cooldownKeyFor("pr_review", ctx));
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
