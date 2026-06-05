import { describe, expect, test } from "bun:test";
import { isHousekeepingPr } from "../github.ts";

describe("isHousekeepingPr", () => {
  test("flags release cuts + version bumps (the noise the digest must drop)", () => {
    for (const t of [
      "chore: release v0.8.2 (#830)",
      "chore(release): bump to v0.8.1 (#821)",
      "chore: bump to v0.8.2",
      "chore(deps): bump zod from 3 to 4",
      "build(deps): bump actions/checkout",
      "Release v1.2.0",
    ]) {
      expect(isHousekeepingPr(t, "someone")).toBe(true);
    }
  });

  test("flags automated agent commits", () => {
    expect(isHousekeepingPr("chore: auto-commit agent progress before verification", "automaker")).toBe(true);
  });

  test("flags bot authors regardless of title", () => {
    expect(isHousekeepingPr("feat: something real", "dependabot[bot]")).toBe(true);
    expect(isHousekeepingPr("feat: something real", "dependabot")).toBe(true);
    expect(isHousekeepingPr("feat: something real", "renovate")).toBe(true);
  });

  test("keeps substantive work (feat/fix/refactor/docs)", () => {
    for (const t of [
      "feat(ceremonies): daily-digest",
      "fix(github): dedup approve-on-green",
      "refactor: split the dispatcher",
      "docs(handoff): 002",
      "chore(logging): migrate discord subsystem", // a chore, but not release/bump/auto-commit
    ]) {
      expect(isHousekeepingPr(t, "josh")).toBe(false);
    }
  });

  test("tolerates empty/missing inputs", () => {
    expect(isHousekeepingPr("", "")).toBe(false);
  });
});
