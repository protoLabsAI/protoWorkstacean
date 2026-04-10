/**
 * Types for the LLM review orchestrator.
 */

import type { ValidatedComment } from "../diff/types.ts";

/** A file from the GitHub PR diff. */
export interface PRFile {
  filename: string;
  status: "added" | "modified" | "removed" | "renamed" | string;
  patch?: string;
  additions: number;
  deletions: number;
  changes: number;
}

/** The result of a full PR review. */
export interface ReviewResult {
  /** Short summary of the PR (from Haiku). */
  summary: string;
  /** All validated inline comments ready for GitHub API submission. */
  comments: ValidatedComment[];
  /** Whether any blocker severity comments exist. */
  hasBlockers: boolean;
  /** Review event: REQUEST_CHANGES if blockers, APPROVE if clean. */
  event: "REQUEST_CHANGES" | "APPROVE";
}

/** Per-file review batch for chunked processing. */
export interface ReviewBatch {
  files: PRFile[];
  estimatedTokens: number;
}
