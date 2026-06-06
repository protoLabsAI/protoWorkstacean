/**
 * GitHub PR state helper — fetches PR state to check if a PR has merged.
 *
 * Used by FeatureRemediationPlugin to verify origin truth before escalating
 * a blocked feature. Prevents false pages when work has already shipped
 * (PR merged + feature done) but protoMaker's `feature.completed` event
 * hasn't arrived yet.
 *
 * `authGetter` and `fetchImpl` are injectable so unit tests never touch
 * the network or `process.env`.
 */

import { makeGitHubAuth } from "./github-auth.ts";

/** Minimal PR state shape — only the fields needed for origin-truth checks. */
export interface PrState {
  /** PR number. */
  number: number;
  /** "open", "closed", or undefined. */
  state: string | null;
  /** True if the PR has been merged. */
  merged: boolean;
}

export interface FetchPrStateOpts {
  /** Injected for tests; defaults to the shared makeGitHubAuth resolution. */
  authGetter?: (owner: string, repo: string) => Promise<string>;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "protoWorkstacean/1.0",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * Fetch PR state from GitHub API. Returns null on failure (404, auth error,
 * network issue) — caller treats null as "unknown" (not "not merged").
 */
export async function fetchPrState(
  owner: string,
  repo: string,
  prNumber: number,
  opts: FetchPrStateOpts = {},
): Promise<PrState | null> {
  const auth = opts.authGetter ?? makeGitHubAuth();
  if (!auth) return null;

  const doFetch = opts.fetchImpl ?? fetch;
  let token: string;
  try {
    token = await auth(owner, repo);
  } catch {
    return null;
  }

  const resp = await doFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    { headers: ghHeaders(token) },
  );

  if (!resp.ok) return null;

  const data = (await resp.json()) as Record<string, unknown>;
  return {
    number: prNumber,
    state: (data.state as string | null) ?? null,
    merged: Boolean(data.merged),
  };
}
