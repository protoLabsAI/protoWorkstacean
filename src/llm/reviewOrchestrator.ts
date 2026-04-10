/**
 * reviewOrchestrator — coordinates the LLM review pipeline for a PR.
 *
 * Flow:
 *   1. Fetch PR diff files from GitHub API
 *   2. Chunk large diffs by token budget (80% of 100k token budget)
 *   3. Call Claude Haiku for PR summary
 *   4. Call Claude Sonnet for per-file inline review (per batch)
 *   5. Parse and aggregate LLM JSON responses
 *   6. Validate all comments through validateComments pipeline
 *   7. Return ReviewResult with event (REQUEST_CHANGES | APPROVE)
 *
 * Env vars:
 *   ANTHROPIC_API_KEY — required for Claude API calls
 */

import Anthropic from "@anthropic-ai/sdk";
import { parsePatch } from "../diff/parsePatch.ts";
import { validateComments } from "../diff/validateComments.ts";
import { buildSummaryPrompt, buildInlineReviewPrompt } from "./promptBuilder.ts";
import type { PRFile, ReviewResult, ReviewBatch } from "./types.ts";
import type { LLMComment, AnnotatedHunk } from "../diff/types.ts";

/** Token budget: 80% of ~100k Sonnet context window. */
const TOKEN_BUDGET = 80_000;
/** Approximate chars per token. */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count for a file's patch.
 */
function estimateFileTokens(file: PRFile): number {
  const patchLen = file.patch?.length ?? 0;
  return Math.ceil((file.filename.length + patchLen) / CHARS_PER_TOKEN);
}

/**
 * Split files into batches that fit within the token budget.
 * Files are sorted by size ascending so small files fill batches first.
 */
export function chunkFilesIntoBatches(files: PRFile[]): ReviewBatch[] {
  const sorted = [...files].sort(
    (a, b) => estimateFileTokens(a) - estimateFileTokens(b),
  );

  const batches: ReviewBatch[] = [];
  let currentBatch: PRFile[] = [];
  let currentTokens = 0;

  for (const file of sorted) {
    if (!file.patch) continue;

    const fileTokens = estimateFileTokens(file);

    if (currentTokens + fileTokens > TOKEN_BUDGET && currentBatch.length > 0) {
      batches.push({ files: currentBatch, estimatedTokens: currentTokens });
      currentBatch = [];
      currentTokens = 0;
    }

    currentBatch.push(file);
    currentTokens += fileTokens;
  }

  if (currentBatch.length > 0) {
    batches.push({ files: currentBatch, estimatedTokens: currentTokens });
  }

  return batches;
}

/**
 * Parse the JSON array from the LLM response body.
 * Returns an empty array if parsing fails.
 */
function parseLLMComments(text: string): LLMComment[] {
  try {
    // Extract JSON array from potentially wrapped response
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed as LLMComment[];
  } catch {
    console.warn("[reviewOrchestrator] Failed to parse LLM comment JSON:", text.slice(0, 200));
    return [];
  }
}

/**
 * Fetch PR diff files from the GitHub API.
 */
async function fetchPRFiles(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<PRFile[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "protoWorkstacean/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API error fetching PR files: ${res.status} ${await res.text()}`);
  }

  return res.json() as Promise<PRFile[]>;
}

/**
 * Fetch the PR metadata (title, body, head SHA) from the GitHub API.
 */
async function fetchPRMeta(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<{ title: string; body: string; headSha: string; draft: boolean }> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "protoWorkstacean/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API error fetching PR meta: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as {
    title: string;
    body: string | null;
    draft: boolean;
    head: { sha: string };
  };

  return {
    title: data.title,
    body: data.body ?? "",
    headSha: data.head.sha,
    draft: data.draft,
  };
}

/**
 * Run the full PR review pipeline.
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param prNumber - PR number
 * @param getToken - Function to get a GitHub auth token
 * @returns ReviewResult with comments and event decision
 */
export async function review(
  owner: string,
  repo: string,
  prNumber: number,
  getToken: (owner: string, repo: string) => Promise<string>,
): Promise<ReviewResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for PR review");
  }

  const client = new Anthropic({ apiKey });
  const token = await getToken(owner, repo);

  // Fetch PR metadata and files
  const [meta, files] = await Promise.all([
    fetchPRMeta(owner, repo, prNumber, token),
    fetchPRFiles(owner, repo, prNumber, token),
  ]);

  // Skip draft PRs
  if (meta.draft) {
    console.log(`[reviewOrchestrator] PR #${prNumber} is a draft — skipping review`);
    return {
      summary: "Draft PR — review skipped",
      comments: [],
      hasBlockers: false,
      event: "APPROVE",
    };
  }

  // Haiku: generate PR summary
  let summary = "";
  try {
    const summaryPrompt = buildSummaryPrompt(meta.title, meta.body, files);
    const summaryResp = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{ role: "user", content: summaryPrompt }],
    });
    const summaryBlock = summaryResp.content[0];
    summary = summaryBlock.type === "text" ? summaryBlock.text : "";
  } catch (err) {
    console.warn("[reviewOrchestrator] Haiku summary failed:", err);
    summary = `PR #${prNumber}: ${meta.title}`;
  }

  // Sonnet: inline review per batch
  const batches = chunkFilesIntoBatches(files);
  const allRawComments: LLMComment[] = [];

  for (const batch of batches) {
    const prompt = buildInlineReviewPrompt(batch.files);
    if (!prompt) continue;

    try {
      const reviewResp = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      });
      const block = reviewResp.content[0];
      if (block.type === "text") {
        const batchComments = parseLLMComments(block.text);
        allRawComments.push(...batchComments);
      }
    } catch (err) {
      console.warn(`[reviewOrchestrator] Sonnet review failed for batch (${batch.files.length} files):`, err);
    }
  }

  // Build hunk map for validation
  const allHunks: AnnotatedHunk[] = [];
  for (const file of files) {
    if (file.patch) {
      allHunks.push(...parsePatch(file.patch, file.filename));
    }
  }

  // Validate all comments before submission
  const validatedComments = validateComments(allRawComments, allHunks);
  const hasBlockers = validatedComments.some(c => c.severity === "blocker");

  return {
    summary,
    comments: validatedComments,
    hasBlockers,
    event: hasBlockers ? "REQUEST_CHANGES" : "APPROVE",
  };
}
