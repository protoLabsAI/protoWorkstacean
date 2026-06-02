import { describe, test, expect } from "bun:test";
import {
  emitSkillResult,
  readSkillResult,
  submitToolName,
  SUBMIT_TOOL_PREFIX,
  SUBMIT_TOOL_NAME_RE,
  dataPart,
  partData,
} from "@protolabs/a2a";

const PR_DIAGNOSIS_MIME = "application/vnd.protolabs.pr-diagnosis-v1+json";

describe("emitSkillResult", () => {
  test("builds a DataPart on the same wire as the extensions (data $case + mimeType)", () => {
    const obj = { verdict: "rebasable", evidence: "5 files, all docs" };
    const part = emitSkillResult(obj, PR_DIAGNOSIS_MIME);

    // Identical shape to dataPart(obj, mime) — it's a thin named wrapper.
    expect(part).toEqual(dataPart(obj, PR_DIAGNOSIS_MIME));
    expect(part.content).toEqual({ $case: "data", value: obj });
    expect(part.metadata).toEqual({ mimeType: PR_DIAGNOSIS_MIME });
    expect(part.mediaType).toBe("application/json");
  });

  test("round-trips: emit then read by MIME returns the original object", () => {
    const obj = { verdict: "genuine", evidence: "both sides diverged", conflictingFiles: ["a.ts"] };
    const part = emitSkillResult(obj, PR_DIAGNOSIS_MIME);
    const read = readSkillResult<typeof obj>([part], PR_DIAGNOSIS_MIME);
    expect(read).toEqual(obj);
  });

  test("read coexists with the generic partData reader", () => {
    const obj = { verdict: "redundant" };
    const part = emitSkillResult(obj, PR_DIAGNOSIS_MIME);
    expect(partData(part)).toEqual(obj);
  });

  test("readSkillResult skips parts with a different MIME", () => {
    const part = emitSkillResult({ verdict: "rebasable" }, "application/vnd.protolabs.other-v1+json");
    expect(readSkillResult([part], PR_DIAGNOSIS_MIME)).toBeUndefined();
  });

  test("readSkillResult returns the first matching part", () => {
    const a = emitSkillResult({ verdict: "rebasable" }, PR_DIAGNOSIS_MIME);
    const b = emitSkillResult({ verdict: "genuine" }, PR_DIAGNOSIS_MIME);
    expect(readSkillResult<{ verdict: string }>([a, b], PR_DIAGNOSIS_MIME)?.verdict).toBe("rebasable");
  });

  test("readSkillResult on an empty parts array is undefined", () => {
    expect(readSkillResult([], PR_DIAGNOSIS_MIME)).toBeUndefined();
  });
});

describe("submitToolName convention", () => {
  test("prefixes the skill with submit_", () => {
    expect(submitToolName("diagnose_pr_stuck")).toBe("submit_diagnose_pr_stuck");
    expect(SUBMIT_TOOL_PREFIX).toBe("submit_");
  });

  test("the regex matches the convention and captures the skill", () => {
    const name = submitToolName("diagnose_pr_stuck");
    const m = name.match(SUBMIT_TOOL_NAME_RE);
    expect(m?.[1]).toBe("diagnose_pr_stuck");
  });

  test("the regex does not match an unrelated tool name", () => {
    expect("pr_inspector".match(SUBMIT_TOOL_NAME_RE)).toBeNull();
  });
});
