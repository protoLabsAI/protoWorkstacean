/**
 * parsePatch — unified diff parser with absolute line number annotation.
 *
 * Parses the raw `patch` string from a GitHub PR file diff, extracts each hunk,
 * and annotates each + (addition) and context line with its absolute line number
 * in the new file. Deleted (-) lines are marked with lineNumber: null.
 *
 * Returns an array of AnnotatedHunk objects ready for LLM context injection
 * and comment validation.
 */

import type { AnnotatedHunk, AnnotatedLine } from "./types.ts";

/** Regex to parse @@ hunk header: @@ -oldStart,oldCount +newStart,newCount @@ ... */
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff patch string into annotated hunks.
 *
 * @param patch - The raw unified diff string (as returned by GitHub API `files[].patch`)
 * @param filePath - The path of the file being diffed
 * @returns Array of AnnotatedHunk objects
 */
export function parsePatch(patch: string, filePath: string): AnnotatedHunk[] {
  const hunks: AnnotatedHunk[] = [];
  const rawLines = patch.split("\n");

  let i = 0;

  while (i < rawLines.length) {
    const line = rawLines[i];

    // Skip diff file headers (---, +++ lines)
    if (line.startsWith("---") || line.startsWith("+++")) {
      i++;
      continue;
    }

    const headerMatch = line.match(HUNK_HEADER_RE);
    if (!headerMatch) {
      i++;
      continue;
    }

    const newStart = parseInt(headerMatch[2], 10);
    const newCount = headerMatch[3] !== undefined ? parseInt(headerMatch[3], 10) : 1;
    const header = line;
    i++;

    const annotatedLines: AnnotatedLine[] = [];
    let currentNewLine = newStart;
    // newEnd is the last line in the new file covered by this hunk
    const newEnd = newCount === 0 ? newStart : newStart + newCount - 1;

    while (i < rawLines.length) {
      const hunkLine = rawLines[i];

      // Next hunk header — stop processing current hunk
      if (hunkLine.match(HUNK_HEADER_RE)) break;
      // File header for next file — stop
      if (hunkLine.startsWith("diff ")) break;

      if (hunkLine.startsWith("+")) {
        annotatedLines.push({
          lineNumber: currentNewLine,
          content: hunkLine.slice(1),
          type: "+",
        });
        currentNewLine++;
      } else if (hunkLine.startsWith("-")) {
        annotatedLines.push({
          lineNumber: null,
          content: hunkLine.slice(1),
          type: "-",
        });
        // Deleted lines don't advance the new file line counter
      } else if (hunkLine.startsWith(" ") || hunkLine === "") {
        // Context line (space prefix) or empty line within hunk
        annotatedLines.push({
          lineNumber: currentNewLine,
          content: hunkLine.startsWith(" ") ? hunkLine.slice(1) : hunkLine,
          type: " ",
        });
        currentNewLine++;
      } else {
        // Unexpected prefix — treat as context
        annotatedLines.push({
          lineNumber: currentNewLine,
          content: hunkLine,
          type: " ",
        });
        currentNewLine++;
      }

      i++;
    }

    hunks.push({
      filePath,
      newStart,
      newEnd: Math.max(newEnd, currentNewLine - 1),
      lines: annotatedLines,
      header,
    });
  }

  return hunks;
}

/**
 * Format annotated hunks into a string suitable for LLM context injection.
 * Each line is prefixed with [NNNN] for additions/context, [DEL] for deletions.
 */
export function formatHunksForLLM(hunks: AnnotatedHunk[]): string {
  const parts: string[] = [];

  for (const hunk of hunks) {
    parts.push(`\n${hunk.header}`);
    for (const line of hunk.lines) {
      if (line.type === "-") {
        parts.push(`[DEL] ${line.content}`);
      } else {
        const num = String(line.lineNumber ?? "?").padStart(4, "0");
        const prefix = line.type === "+" ? "+" : " ";
        parts.push(`[${num}]${prefix}${line.content}`);
      }
    }
  }

  return parts.join("\n");
}
