/**
 * GitHub diff fetcher — retrieves PR diff, inline review comments, and
 * the overall review decision (APPROVE / REQUEST_CHANGES) from the GitHub API.
 */

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "protoWorkstacean/1.0";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PRMetadata {
  owner: string;
  repo: string;
  prNumber: number;
  baseBranch: string;
  mergedAt: string;
  prUrl: string;
  title: string;
}

export interface ReviewComment {
  body: string;
  path: string;
  line: number | null;
  author: string;
  isQuinn: boolean;
}

export type ReviewDecision = "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | "PENDING";

export interface PRReviewData {
  diff: string;
  comments: ReviewComment[];
  decision: ReviewDecision;
  reviewIssues: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ── Fetchers ───────────────────────────────────────────────────────────────────

/**
 * Fetch the unified diff for a PR.
 * Returns empty string if unavailable.
 */
export async function fetchPRDiff(meta: PRMetadata, token: string): Promise<string> {
  const url = `${GITHUB_API}/repos/${meta.owner}/${meta.repo}/pulls/${meta.prNumber}`;
  try {
    const res = await fetch(url, {
      headers: {
        ...makeHeaders(token),
        Accept: "application/vnd.github.diff",
      },
    });
    if (!res.ok) {
      console.error(`[diff-fetcher] fetchPRDiff failed ${res.status}`);
      return "";
    }
    return await res.text();
  } catch (err) {
    console.error("[diff-fetcher] fetchPRDiff error:", err);
    return "";
  }
}

/**
 * Fetch inline review comments for a PR.
 */
export async function fetchReviewComments(
  meta: PRMetadata,
  token: string,
): Promise<ReviewComment[]> {
  const url = `${GITHUB_API}/repos/${meta.owner}/${meta.repo}/pulls/${meta.prNumber}/comments`;
  try {
    const res = await fetch(url, { headers: makeHeaders(token) });
    if (!res.ok) {
      console.error(`[diff-fetcher] fetchReviewComments failed ${res.status}`);
      return [];
    }
    const raw = await res.json() as Array<{
      body?: string;
      path?: string;
      line?: number | null;
      original_line?: number | null;
      user?: { login?: string };
    }>;

    return raw.map(c => ({
      body: c.body ?? "",
      path: c.path ?? "",
      line: c.line ?? c.original_line ?? null,
      author: c.user?.login ?? "",
      isQuinn: (c.user?.login ?? "").includes("quinn"),
    }));
  } catch (err) {
    console.error("[diff-fetcher] fetchReviewComments error:", err);
    return [];
  }
}

/**
 * Fetch the overall review decision for a PR.
 * Returns the most recent non-PENDING state submitted by a reviewer.
 */
export async function fetchReviewDecision(
  meta: PRMetadata,
  token: string,
): Promise<ReviewDecision> {
  const url = `${GITHUB_API}/repos/${meta.owner}/${meta.repo}/pulls/${meta.prNumber}/reviews`;
  try {
    const res = await fetch(url, { headers: makeHeaders(token) });
    if (!res.ok) return "PENDING";

    const reviews = await res.json() as Array<{
      state?: string;
      submitted_at?: string;
    }>;

    // Find the most recent decisive state
    const decisive = reviews
      .filter(r => r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")
      .sort((a, b) => new Date(b.submitted_at ?? 0).getTime() - new Date(a.submitted_at ?? 0).getTime());

    if (!decisive.length) return "COMMENT";
    return decisive[0].state === "APPROVED" ? "APPROVE" : "REQUEST_CHANGES";
  } catch (err) {
    console.error("[diff-fetcher] fetchReviewDecision error:", err);
    return "PENDING";
  }
}

/**
 * Summarize review issues into a short comma-separated string.
 * Extracts first sentence or up to 80 chars from each Quinn comment body.
 */
export function summarizeReviewIssues(comments: ReviewComment[]): string {
  return comments
    .filter(c => c.isQuinn && c.body.trim().length > 0)
    .map(c => c.body.split(/\n|\./)[0].trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 5)
    .join("; ");
}

/**
 * Fetch all PR review data in one call.
 */
export async function fetchPRReviewData(
  meta: PRMetadata,
  token: string,
): Promise<PRReviewData> {
  const [diff, comments, decision] = await Promise.all([
    fetchPRDiff(meta, token),
    fetchReviewComments(meta, token),
    fetchReviewDecision(meta, token),
  ]);

  return {
    diff,
    comments,
    decision,
    reviewIssues: summarizeReviewIssues(comments),
  };
}
