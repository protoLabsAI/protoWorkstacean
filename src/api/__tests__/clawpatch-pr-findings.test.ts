import { describe, expect, test } from "bun:test";
import { selectPrFindings, PR_FINDINGS_CAP } from "../clawpatch.ts";

function item(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "fnd_1",
    title: "Missing null check",
    severity: "high",
    category: "correctness",
    confidence: "high",
    status: "open",
    evidence: [{ path: "src/a.ts", startLine: 10, endLine: 12 }],
    recommendation: "Guard the null case.",
    ...over,
  };
}

describe("selectPrFindings", () => {
  test("keeps only findings whose evidence touches a changed file", () => {
    const items = [
      item({ id: "in", evidence: [{ path: "src/a.ts", startLine: 1 }] }),
      item({ id: "out", evidence: [{ path: "src/unrelated.ts", startLine: 1 }] }),
    ];
    const picked = selectPrFindings(items, ["src/a.ts", "src/b.ts"]);
    expect(picked.map((f) => f.id)).toEqual(["in"]);
  });

  test("sorts by severity then confidence — critical/high surface first", () => {
    const items = [
      item({ id: "low", severity: "low" }),
      item({ id: "crit", severity: "critical", confidence: "low" }),
      item({ id: "high-med", severity: "high", confidence: "medium" }),
      item({ id: "high-hi", severity: "high", confidence: "high" }),
    ];
    const picked = selectPrFindings(items, ["src/a.ts"]);
    expect(picked.map((f) => f.id)).toEqual(["crit", "high-hi", "high-med", "low"]);
  });

  test("caps the result and skips malformed items without throwing", () => {
    const items: unknown[] = [
      null,
      42,
      { title: "no id" },
      item({ id: "ok", evidence: [{ path: "src/a.ts" }, { notAPath: true }] }),
      ...Array.from({ length: PR_FINDINGS_CAP + 5 }, (_, i) => item({ id: `f${i}` })),
    ];
    const picked = selectPrFindings(items, ["src/a.ts"]);
    expect(picked.length).toBe(PR_FINDINGS_CAP);
    expect(picked.some((f) => f.id === "ok")).toBe(true);
    // evidence entries without a string path are dropped, valid ones kept
    expect(picked.find((f) => f.id === "ok")!.evidence).toEqual([{ path: "src/a.ts" }]);
  });

  test("empty changed-paths yields nothing (a finding must anchor to this PR)", () => {
    expect(selectPrFindings([item()], [])).toEqual([]);
  });
});
