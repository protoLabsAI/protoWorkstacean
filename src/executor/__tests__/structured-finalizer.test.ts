import { describe, test, expect } from "bun:test";
import { runStructuredFinalizer, jsonSchemaToZod, type ForcedToolCaller } from "../executors/structured-finalizer.ts";
import { emitSkillResult, readSkillResult, submitToolName } from "@protolabs/a2a";
import type { JsonSchema } from "../../agent-runtime/types.ts";

const PR_DIAGNOSIS_MIME = "application/vnd.protolabs.pr-diagnosis-v1+json";

const diagnosisSchema: JsonSchema = {
  type: "object",
  required: ["verdict", "evidence"],
  properties: {
    verdict: { type: "string", enum: ["redundant", "rebasable", "decomposable", "genuine"] },
    evidence: { type: "string" },
    conflictingFiles: { type: "array", items: { type: "string" } },
    supersededBy: { type: "array", items: { type: "string" } },
  },
};

describe("jsonSchemaToZod", () => {
  const v = jsonSchemaToZod(diagnosisSchema);

  test("accepts a valid object", () => {
    expect(v.safeParse({ verdict: "rebasable", evidence: "5 files, all docs" }).success).toBe(true);
  });

  test("rejects an out-of-enum verdict", () => {
    expect(v.safeParse({ verdict: "maybe", evidence: "x" }).success).toBe(false);
  });

  test("rejects a missing required field", () => {
    expect(v.safeParse({ verdict: "genuine" }).success).toBe(false);
  });

  test("rejects a wrong-typed array element", () => {
    expect(v.safeParse({ verdict: "genuine", evidence: "x", conflictingFiles: [1, 2] }).success).toBe(false);
  });

  test("passes through unknown extra keys", () => {
    const parsed = v.safeParse({ verdict: "genuine", evidence: "x", note: "extra" });
    expect(parsed.success).toBe(true);
  });
});

describe("runStructuredFinalizer", () => {
  test("a valid first attempt yields the object with repaired=false", async () => {
    const call: ForcedToolCaller = async ({ toolName }) => {
      expect(toolName).toBe(submitToolName("diagnose_pr_stuck"));
      return { verdict: "rebasable", evidence: "5 files, all docs" };
    };
    const out = await runStructuredFinalizer("diagnose_pr_stuck", diagnosisSchema, "analysis text", call);
    expect(out.repaired).toBe(false);
    expect(out.value).toEqual({ verdict: "rebasable", evidence: "5 files, all docs" });

    // The validated object emits a spec-correct DataPart read back by MIME.
    const part = emitSkillResult(out.value, PR_DIAGNOSIS_MIME);
    expect(readSkillResult<{ verdict: string }>([part], PR_DIAGNOSIS_MIME)?.verdict).toBe("rebasable");
  });

  test("an invalid first attempt is repaired on the second call", async () => {
    let n = 0;
    const call: ForcedToolCaller = async ({ system }) => {
      n += 1;
      if (n === 1) return { verdict: "definitely-broken", evidence: 42 };
      // The repair turn is told why it failed.
      expect(system).toContain("failed schema validation");
      return { verdict: "genuine", evidence: "both sides diverged" };
    };
    const out = await runStructuredFinalizer("diagnose_pr_stuck", diagnosisSchema, "analysis", call);
    expect(n).toBe(2);
    expect(out.repaired).toBe(true);
    expect(out.value).toEqual({ verdict: "genuine", evidence: "both sides diverged" });
  });

  test("throws when both the attempt and the single repair fail validation", async () => {
    const call: ForcedToolCaller = async () => ({ verdict: "nope" });
    await expect(
      runStructuredFinalizer("diagnose_pr_stuck", diagnosisSchema, "analysis", call),
    ).rejects.toThrow(/failed validation after one repair/);
  });

  test("only one repair is attempted (caller invoked exactly twice on failure)", async () => {
    let n = 0;
    const call: ForcedToolCaller = async () => {
      n += 1;
      return { bad: true };
    };
    await expect(
      runStructuredFinalizer("diagnose_pr_stuck", diagnosisSchema, "analysis", call),
    ).rejects.toThrow();
    expect(n).toBe(2);
  });
});
