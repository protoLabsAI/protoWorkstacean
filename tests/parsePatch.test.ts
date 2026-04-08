import { describe, test, expect } from "bun:test";
import { parsePatch, formatHunksForLLM } from "../src/diff/parsePatch.ts";

describe("parsePatch", () => {
  test("parses a simple single-hunk diff", () => {
    const patch = `@@ -1,4 +1,5 @@
 line1
 line2
+added line
 line3
-removed line`;

    const hunks = parsePatch(patch, "src/foo.ts");
    expect(hunks).toHaveLength(1);

    const hunk = hunks[0];
    expect(hunk.filePath).toBe("src/foo.ts");
    expect(hunk.newStart).toBe(1);

    // Check line annotations
    const addedLine = hunk.lines.find(l => l.type === "+");
    expect(addedLine).toBeDefined();
    expect(addedLine!.lineNumber).toBe(3);
    expect(addedLine!.content).toBe("added line");

    const deletedLine = hunk.lines.find(l => l.type === "-");
    expect(deletedLine).toBeDefined();
    expect(deletedLine!.lineNumber).toBeNull();
    expect(deletedLine!.content).toBe("removed line");

    const contextLine = hunk.lines.find(l => l.type === " ");
    expect(contextLine).toBeDefined();
    expect(contextLine!.lineNumber).toBe(1);
  });

  test("annotates absolute line numbers correctly", () => {
    const patch = `@@ -10,5 +10,6 @@
 ctx1
 ctx2
+new line
 ctx3
 ctx4
+another new line`;

    const hunks = parsePatch(patch, "src/bar.ts");
    expect(hunks).toHaveLength(1);

    const lines = hunks[0].lines;
    // ctx1 at line 10
    expect(lines[0].lineNumber).toBe(10);
    expect(lines[0].type).toBe(" ");
    // ctx2 at line 11
    expect(lines[1].lineNumber).toBe(11);
    // new line at line 12
    expect(lines[2].lineNumber).toBe(12);
    expect(lines[2].type).toBe("+");
    // ctx3 at line 13
    expect(lines[3].lineNumber).toBe(13);
    // ctx4 at line 14
    expect(lines[4].lineNumber).toBe(14);
    // another new line at line 15
    expect(lines[5].lineNumber).toBe(15);
    expect(lines[5].type).toBe("+");
  });

  test("parses multi-hunk diff", () => {
    const patch = `@@ -1,3 +1,4 @@
 line1
+added in first hunk
 line2
 line3
@@ -20,3 +21,4 @@
 ctx at 21
+added at 22
 ctx at 23
 ctx at 24`;

    const hunks = parsePatch(patch, "src/multi.ts");
    expect(hunks).toHaveLength(2);

    expect(hunks[0].newStart).toBe(1);
    expect(hunks[1].newStart).toBe(21);

    const added1 = hunks[0].lines.find(l => l.type === "+");
    expect(added1!.lineNumber).toBe(2);

    const added2 = hunks[1].lines.find(l => l.type === "+");
    expect(added2!.lineNumber).toBe(22);
  });

  test("marks deleted lines with null lineNumber", () => {
    const patch = `@@ -1,3 +1,2 @@
 ctx
-deleted line 1
-deleted line 2`;

    const hunks = parsePatch(patch, "src/deleted.ts");
    const deletedLines = hunks[0].lines.filter(l => l.type === "-");
    expect(deletedLines).toHaveLength(2);
    for (const dl of deletedLines) {
      expect(dl.lineNumber).toBeNull();
    }
  });

  test("returns empty array for empty patch", () => {
    const hunks = parsePatch("", "src/empty.ts");
    expect(hunks).toHaveLength(0);
  });

  test("handles hunk with no additions (pure deletion)", () => {
    const patch = `@@ -5,3 +5,0 @@
-removed a
-removed b
-removed c`;

    const hunks = parsePatch(patch, "src/pureDel.ts");
    expect(hunks).toHaveLength(1);
    const lines = hunks[0].lines;
    expect(lines.every(l => l.type === "-")).toBe(true);
    expect(lines.every(l => l.lineNumber === null)).toBe(true);
  });

  test("newStart and newEnd are set correctly", () => {
    const patch = `@@ -1,2 +1,4 @@
 ctx
+add1
+add2
 ctx2`;

    const hunks = parsePatch(patch, "src/bounds.ts");
    expect(hunks[0].newStart).toBe(1);
    expect(hunks[0].newEnd).toBe(4);
  });
});

describe("formatHunksForLLM", () => {
  test("formats hunks with line number annotations", () => {
    const patch = `@@ -1,2 +1,3 @@
 context
+added
 context2`;

    const hunks = parsePatch(patch, "src/fmt.ts");
    const formatted = formatHunksForLLM(hunks);

    expect(formatted).toContain("[0001]");
    expect(formatted).toContain("[0002]+added");
    expect(formatted).not.toContain("[DEL]");
  });

  test("marks deleted lines with [DEL]", () => {
    const patch = `@@ -1,2 +1,1 @@
-deleted line
 context`;

    const hunks = parsePatch(patch, "src/del.ts");
    const formatted = formatHunksForLLM(hunks);
    expect(formatted).toContain("[DEL] deleted line");
  });
});
