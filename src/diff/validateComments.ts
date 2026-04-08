/**
 * validateComments — comment validation pipeline.
 *
 * Validates every LLM-generated comment against hunk bounds before GitHub API submission.
 * Invalid comments are silently dropped (with a warning log).
 * Comments on deleted lines are converted to file-level (dropped from inline).
 * Returns a safe array of ValidatedComment objects ready for the GitHub Review API.
 */

import type { LLMComment, ValidatedComment, AnnotatedHunk } from "./types.ts";

/**
 * Check if a given line number falls within any hunk for the specified file.
 * Returns the hunk if found, null otherwise.
 */
function findHunkForLine(
  filePath: string,
  lineNumber: number,
  hunks: AnnotatedHunk[],
): AnnotatedHunk | null {
  for (const hunk of hunks) {
    if (hunk.filePath !== filePath) continue;
    if (lineNumber >= hunk.newStart && lineNumber <= hunk.newEnd) {
      // Verify the line is actually an addition or context line (not deleted)
      const annotated = hunk.lines.find(
        l => l.lineNumber === lineNumber && (l.type === "+" || l.type === " "),
      );
      if (annotated) return hunk;
    }
  }
  return null;
}

/**
 * Check if a line number corresponds to a deleted line in any hunk.
 */
function isDeletedLine(
  filePath: string,
  lineNumber: number,
  hunks: AnnotatedHunk[],
): boolean {
  for (const hunk of hunks) {
    if (hunk.filePath !== filePath) continue;
    // Deleted lines don't have a lineNumber — check by position within hunk bounds
    // A comment on a deleted line would reference a line that doesn't appear in the new file
    // We check if the line is NOT in any hunk's valid (non-null) lines
    const validLines = hunk.lines
      .filter(l => l.lineNumber !== null)
      .map(l => l.lineNumber as number);
    if (validLines.includes(lineNumber)) return false;
  }
  // If the line isn't in any valid position, it may be a deleted line
  return false;
}

/**
 * Validate LLM comments against hunk bounds.
 *
 * Rules:
 * 1. line_start and line_end must both fall within hunk bounds for the file.
 * 2. Comments on deleted lines (lineNumber: null) are dropped.
 * 3. Multi-line comments spanning multiple hunks are split to single-line.
 * 4. Invalid comments are silently dropped with a warning log.
 *
 * @param comments - Raw comments from LLM output
 * @param hunks - Annotated hunks from parsePatch
 * @returns Array of validated comments safe for GitHub API submission
 */
export function validateComments(
  comments: LLMComment[],
  hunks: AnnotatedHunk[],
): ValidatedComment[] {
  const validated: ValidatedComment[] = [];

  for (const comment of comments) {
    const { path, line_start, line_end, severity, body, category } = comment;

    // Validate line_end is within hunk bounds
    const endHunk = findHunkForLine(path, line_end, hunks);
    if (!endHunk) {
      console.warn(
        `[validateComments] Dropping comment: ${path}:${line_end} is outside hunk bounds or on a deleted line`,
      );
      continue;
    }

    // For single-line comments
    if (line_start === line_end) {
      validated.push({
        path,
        line: line_end,
        side: "RIGHT",
        body,
        severity,
        category,
      });
      continue;
    }

    // For multi-line comments: validate start line too
    const startHunk = findHunkForLine(path, line_start, hunks);
    if (!startHunk) {
      // Start line is invalid — fall back to single-line at line_end
      console.warn(
        `[validateComments] Multi-line comment ${path}:${line_start}-${line_end}: start line outside bounds, falling back to single-line at ${line_end}`,
      );
      validated.push({
        path,
        line: line_end,
        side: "RIGHT",
        body,
        severity,
        category,
      });
      continue;
    }

    // Check if start and end are in different hunks — split into single-line at end
    if (startHunk !== endHunk) {
      console.warn(
        `[validateComments] Multi-line comment ${path}:${line_start}-${line_end} spans multiple hunks, splitting to single-line at ${line_end}`,
      );
      validated.push({
        path,
        line: line_end,
        side: "RIGHT",
        body,
        severity,
        category,
      });
      continue;
    }

    // Valid multi-line comment within the same hunk
    validated.push({
      path,
      line: line_end,
      start_line: line_start,
      side: "RIGHT",
      body,
      severity,
      category,
    });
  }

  return validated;
}
