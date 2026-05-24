import { describe, expect, test } from "bun:test";
import { normalizeIssueTitle } from "../github.ts";

describe("normalizeIssueTitle", () => {
  test("identical titles match", () => {
    expect(normalizeIssueTitle("Close #100")).toBe(normalizeIssueTitle("Close #100"));
  });

  test("strips Triage: prefix (the #556 cascade pattern)", () => {
    const a = normalizeIssueTitle("[Triage] #3689 and #3684 — Resolved by PR #3671 (needs manual close)");
    const b = normalizeIssueTitle("Triage: #3689 and #3684 are already fixed by PR #3671");
    const c = normalizeIssueTitle("Action: Close #3689 and #3684 (Already Fixed by PR #3671)");
    // a / b / c are NOT identical post-normalize (they say different things),
    // but they all keep the meaningful `#3689 #3684 #3671` issue refs that
    // dedup logic can compare on stricter matchers downstream. The critical
    // thing is the leading "[Triage] " / "Triage: " / "Action: " prefixes
    // are gone so the same underlying intent isn't multi-filed.
    expect(a.startsWith("triage")).toBe(false);
    expect(a.startsWith("[triage")).toBe(false);
    expect(b.startsWith("triage")).toBe(false);
    expect(c.startsWith("action")).toBe(false);
  });

  test("exact same intent across two punctuation variants normalizes to the same string", () => {
    const a = normalizeIssueTitle("Close #3689 and #3684 — Already Fixed by PR #3671");
    const b = normalizeIssueTitle("Close #3689 and #3684 (Already Fixed by PR #3671)");
    const c = normalizeIssueTitle("Close #3689, and #3684: Already Fixed by PR #3671!");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  test("preserves issue ref tokens (# stays through)", () => {
    expect(normalizeIssueTitle("Close #100 and #200")).toContain("#100");
    expect(normalizeIssueTitle("Close #100 and #200")).toContain("#200");
  });

  test("collapses whitespace + trims", () => {
    expect(normalizeIssueTitle("  hello   world   ")).toBe("hello world");
  });

  test("lowercases", () => {
    expect(normalizeIssueTitle("HELLO World")).toBe("hello world");
  });

  test("DIFFERENT intents do NOT collide", () => {
    expect(normalizeIssueTitle("Close #100")).not.toBe(normalizeIssueTitle("Close #101"));
    expect(normalizeIssueTitle("Close #100")).not.toBe(normalizeIssueTitle("Reopen #100"));
  });

  test("handles bare titles (no prefix) untouched aside from normalization", () => {
    expect(normalizeIssueTitle("Failing CI on PR #536")).toBe("failing ci on pr #536");
  });

  test("multi-prefix doesn't infinite-loop", () => {
    // Two prefixes back-to-back — regex strips both
    expect(normalizeIssueTitle("Triage: Action: Close #100")).toBe("close #100");
  });
});
