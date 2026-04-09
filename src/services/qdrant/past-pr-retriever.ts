/**
 * Past PR retriever — queries quinn-pr-history for the 3 most recent PRs
 * that touched a given file, returning decisions and flagged issues.
 */

import { searchPoints } from "./client.ts";
import { COLLECTION_PR_HISTORY } from "./collections.ts";
import { embed } from "../embeddings/ollama-client.ts";

const PAST_PR_LIMIT = 3;

export interface PastPRDecision {
  prNumber: number;
  prUrl: string;
  decision: string;
  mergedAt: string;
  reviewIssues: string;
  file: string;
  score: number;
}

/**
 * Retrieve the 3 most recent PR decisions for a given file.
 * Uses semantic search on the file path — not a metadata filter — so it
 * also surfaces PRs that touched closely related files.
 *
 * Returns empty array if Qdrant is unavailable.
 */
export async function retrievePastPRDecisions(
  repo: string,
  filePath: string,
): Promise<PastPRDecision[]> {
  const query = `File: ${filePath} in repo ${repo}`;
  const vector = await embed(query);
  if (!vector) return [];

  // Filter by repo to avoid cross-repo noise
  const filter = {
    must: [{ key: "repo", match: { value: repo } }],
  };

  const results = await searchPoints(
    COLLECTION_PR_HISTORY,
    vector,
    PAST_PR_LIMIT,
    filter,
  );

  return results.map(r => ({
    prNumber: Number(r.payload.pr_number ?? 0),
    prUrl: String(r.payload.pr_url ?? ""),
    decision: String(r.payload.decision ?? ""),
    mergedAt: String(r.payload.merged_at ?? ""),
    reviewIssues: String(r.payload.review_issues ?? ""),
    file: String(r.payload.file ?? ""),
    score: r.score,
  }));
}

/**
 * Retrieve past PR decisions for a list of files.
 * Returns a map of filePath → decisions.
 */
export async function retrieveAllPastPRDecisions(
  repo: string,
  filePaths: string[],
): Promise<Map<string, PastPRDecision[]>> {
  const resultMap = new Map<string, PastPRDecision[]>();

  for (const filePath of filePaths) {
    const decisions = await retrievePastPRDecisions(repo, filePath);
    if (decisions.length > 0) {
      resultMap.set(filePath, decisions);
    }
  }

  return resultMap;
}
