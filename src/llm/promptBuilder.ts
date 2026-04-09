/**
 * promptBuilder — builds LLM prompts for PR review.
 *
 * Haiku is used for PR summary generation.
 * Sonnet is used for per-file inline review with structured JSON output.
 */

import type { PRFile } from "./types.ts";
import { parsePatch, formatHunksForLLM } from "../diff/parsePatch.ts";

/** Output schema description embedded in the Sonnet prompt. */
const INLINE_REVIEW_SCHEMA = `
Return ONLY a JSON array (no prose, no markdown). Each element:
{
  "path": "<file path>",
  "line_start": <absolute line number in new file>,
  "line_end": <absolute line number in new file>,
  "severity": "blocker" | "suggestion" | "nit",
  "body": "<concise markdown comment body>",
  "category": "bug" | "security" | "performance" | "style"
}

Rules:
- Only comment on lines marked [NNNN] (additions or context). Never comment on [DEL] lines.
- line_start and line_end must reference the [NNNN] numbers shown in the diff.
- blocker = must fix before merge (bug, security issue, data loss, broken contract)
- suggestion = worth fixing but not blocking
- nit = minor style/naming preference
- If no issues found, return an empty array: []
`.trim();

/**
 * Build the Haiku prompt for generating a PR summary.
 */
export function buildSummaryPrompt(
  prTitle: string,
  prBody: string,
  files: PRFile[],
): string {
  const fileList = files
    .map(f => `- ${f.filename} (+${f.additions}/-${f.deletions})`)
    .join("\n");

  return `You are a senior engineer reviewing a pull request. Write a 2-3 sentence summary of what this PR does and its potential impact.

PR Title: ${prTitle}
PR Description: ${prBody || "(no description provided)"}

Files changed:
${fileList}

Respond with only the summary text, no headings or bullet points.`.trim();
}

/**
 * Build the Sonnet prompt for per-file inline review.
 * Includes the annotated diff with [NNNN] line number prefixes.
 */
export function buildInlineReviewPrompt(files: PRFile[]): string {
  const annotatedFiles: string[] = [];

  for (const file of files) {
    if (!file.patch) continue;

    const hunks = parsePatch(file.patch, file.filename);
    const annotated = formatHunksForLLM(hunks);

    annotatedFiles.push(`\n=== FILE: ${file.filename} ===\n${annotated}`);
  }

  if (annotatedFiles.length === 0) {
    return "";
  }

  return `You are a senior engineer performing a code review. Review the following diff carefully for bugs, security issues, performance problems, and style issues.

${annotatedFiles.join("\n")}

${INLINE_REVIEW_SCHEMA}`.trim();
}
