import { describe, test, expect } from "bun:test";
import { validateComments } from "../src/diff/validateComments.ts";
import { parsePatch } from "../src/diff/parsePatch.ts";
import type { LLMComment } from "../src/diff/types.ts";

const SAMPLE_PATCH = `@@ -1,5 +1,7 @@
 ctx1
 ctx2
+added3
+added4
 ctx5
+added6
 ctx7`;

function makeComment(overrides: Partial<LLMComment> = {}): LLMComment {
  return {
    path: "src/foo.ts",
    line_start: 3,
    line_end: 3,
    severity: "suggestion",
    body: "Test comment",
    category: "style",
    ...overrides,
  };
}

describe("validateComments", () => {
  const hunks = parsePatch(SAMPLE_PATCH, "src/foo.ts");

  test("accepts a valid single-line comment on an addition", () => {
    const comments = [makeComment({ line_start: 3, line_end: 3 })];
    const result = validateComments(comments, hunks);
    expect(result).toHaveLength(1);
    expect(result[0].line).toBe(3);
    expect(result[0].side).toBe("RIGHT");
    expect(result[0].start_line).toBeUndefined();
  });

  test("accepts a valid multi-line comment within the same hunk", () => {
    const comments = [makeComment({ line_start: 3, line_end: 4 })];
    const result = validateComments(comments, hunks);
    expect(result).toHaveLength(1);
    expect(result[0].line).toBe(4);
    expect(result[0].start_line).toBe(3);
    expect(result[0].side).toBe("RIGHT");
  });

  test("drops a comment whose line is outside hunk bounds", () => {
    // Line 100 is not in any hunk
    const comments = [makeComment({ line_start: 100, line_end: 100 })];
    const result = validateComments(comments, hunks);
    expect(result).toHaveLength(0);
  });

  test("drops comment referencing a different file", () => {
    const comments = [makeComment({ path: "src/other.ts", line_start: 3, line_end: 3 })];
    const result = validateComments(comments, hunks);
    expect(result).toHaveLength(0);
  });

  test("handles multi-line comment with invalid start, falls back to single-line", () => {
    // line_start 100 is outside bounds, but line_end 3 is valid
    const comments = [makeComment({ line_start: 100, line_end: 3 })];
    const result = validateComments(comments, hunks);
    expect(result).toHaveLength(1);
    expect(result[0].line).toBe(3);
    expect(result[0].start_line).toBeUndefined();
  });

  test("accepts comment on context line", () => {
    // Line 1 is a context line in the hunk
    const comments = [makeComment({ line_start: 1, line_end: 1 })];
    const result = validateComments(comments, hunks);
    expect(result).toHaveLength(1);
    expect(result[0].line).toBe(1);
  });

  test("preserves severity and category", () => {
    const comments = [makeComment({
      line_start: 3,
      line_end: 3,
      severity: "blocker",
      category: "security",
      body: "Critical vulnerability",
    })];
    const result = validateComments(comments, hunks);
    expect(result[0].severity).toBe("blocker");
    expect(result[0].category).toBe("security");
    expect(result[0].body).toBe("Critical vulnerability");
  });

  test("returns empty array for empty comments", () => {
    const result = validateComments([], hunks);
    expect(result).toHaveLength(0);
  });

  test("processes multiple comments, dropping invalid ones", () => {
    const comments: LLMComment[] = [
      makeComment({ line_start: 3, line_end: 3 }),    // valid
      makeComment({ line_start: 200, line_end: 200 }), // invalid - out of bounds
      makeComment({ line_start: 4, line_end: 4 }),    // valid
      makeComment({ path: "other.ts", line_start: 3, line_end: 3 }), // invalid - wrong file
    ];
    const result = validateComments(comments, hunks);
    expect(result).toHaveLength(2);
    expect(result[0].line).toBe(3);
    expect(result[1].line).toBe(4);
  });

  test("multi-line comment spanning different hunks falls back to single-line", () => {
    const multiHunkPatch = `@@ -1,3 +1,4 @@
 ctx
+add1
 ctx2
@@ -20,3 +21,4 @@
 ctx21
+add22
 ctx23`;

    const multiHunks = parsePatch(multiHunkPatch, "src/multi.ts");

    // line_start=2 is in hunk 1, line_end=22 is in hunk 2
    const comments = [makeComment({
      path: "src/multi.ts",
      line_start: 2,
      line_end: 22,
    })];
    const result = validateComments(comments, multiHunks);
    expect(result).toHaveLength(1);
    expect(result[0].line).toBe(22);
    expect(result[0].start_line).toBeUndefined();
  });
});
