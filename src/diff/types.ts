/**
 * Types for the unified diff parser and comment validation pipeline.
 */

/** A single line annotated with its absolute position in the new file. */
export interface AnnotatedLine {
  /** Absolute line number in the new (right/RIGHT side) file. null for deleted lines. */
  lineNumber: number | null;
  /** Raw content of the line (without the +/-/space prefix). */
  content: string;
  /** '+' = addition, '-' = deletion, ' ' = context */
  type: "+" | "-" | " ";
}

/** A single hunk from a unified diff, with absolute line number annotations. */
export interface AnnotatedHunk {
  /** Path to the file this hunk belongs to. */
  filePath: string;
  /** First absolute line number in the new file covered by this hunk. */
  newStart: number;
  /** Last absolute line number in the new file covered by this hunk. */
  newEnd: number;
  /** All lines in this hunk, annotated with absolute line numbers. */
  lines: AnnotatedLine[];
  /** Raw @@ header string */
  header: string;
}

/** Raw comment from the LLM review output. */
export interface LLMComment {
  /** Path to the file being commented on. */
  path: string;
  /** Starting line number (absolute, in new file). */
  line_start: number;
  /** Ending line number (absolute, in new file). */
  line_end: number;
  /** Severity of the issue found. */
  severity: "blocker" | "suggestion" | "nit";
  /** Comment body text. */
  body: string;
  /** Category of the issue. */
  category: "bug" | "security" | "performance" | "style";
}

/** A comment that has been validated against hunk bounds and is safe to submit. */
export interface ValidatedComment {
  /** Path to the file being commented on. */
  path: string;
  /** Ending/single line number — required by GitHub API. */
  line: number;
  /** Starting line for multi-line comments. Omitted if same as line. */
  start_line?: number;
  /** Always RIGHT for additions/context lines. */
  side: "RIGHT";
  /** Comment body text. */
  body: string;
  /** Severity of the issue. */
  severity: "blocker" | "suggestion" | "nit";
  /** Category of the issue. */
  category: "bug" | "security" | "performance" | "style";
}
