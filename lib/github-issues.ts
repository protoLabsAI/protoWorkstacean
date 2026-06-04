/**
 * GitHub issue close helper — the issues-endpoint counterpart to pr-inspector's
 * PR-close (`setPrState`, which targets `/pulls/{n}`). Closes an issue with an
 * optional comment, authenticating as the Quinn GitHub App (or GITHUB_TOKEN PAT)
 * via the shared `makeGitHubAuth`.
 *
 * Used by IssueCloserPlugin to close the originating GitHub issue when its
 * feature ships (the close-the-loop), and reusable by a future
 * `pr_inspector close_issue` action. `authGetter` / `fetchImpl` are injectable
 * so unit tests never touch the network or `process.env`.
 */

import { makeGitHubAuth } from "./github-auth.ts";
import { logger } from "./log.ts";

const log = logger("github-issues");

export interface CloseIssueOpts {
  /** Comment posted before the close so observers see the rationale first. Best-effort. */
  comment?: string;
  /** GitHub close motive. "completed" (resolved) vs "not_planned" (won't do). */
  reason?: "completed" | "not_planned";
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
    "Content-Type": "application/json",
  };
}

/**
 * Close `owner/name#issueNumber`. Throws (fail-loud) on missing auth or a
 * non-OK PATCH so the caller can surface it; a failed comment is non-fatal
 * (logged, then the close proceeds).
 */
export async function closeIssue(
  owner: string,
  name: string,
  issueNumber: number,
  opts: CloseIssueOpts = {},
): Promise<void> {
  const auth = opts.authGetter ?? makeGitHubAuth();
  if (!auth) {
    throw new Error(
      `[github-issues] no GitHub auth configured (set GITHUB_APP_ID+GITHUB_APP_PRIVATE_KEY or GITHUB_TOKEN) — cannot close ${owner}/${name}#${issueNumber}`,
    );
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const token = await auth(owner, name);
  const headers = ghHeaders(token);

  if (opts.comment && opts.comment.trim()) {
    try {
      const c = await doFetch(`https://api.github.com/repos/${owner}/${name}/issues/${issueNumber}/comments`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: opts.comment }),
      });
      if (!c.ok) {
        log.warn(`comment on ${owner}/${name}#${issueNumber} failed (proceeding to close)`, { status: c.status });
      }
    } catch (e) {
      log.warn(`comment on ${owner}/${name}#${issueNumber} threw (proceeding to close)`, { err: e });
    }
  }

  const resp = await doFetch(`https://api.github.com/repos/${owner}/${name}/issues/${issueNumber}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ state: "closed", state_reason: opts.reason ?? "completed" }),
  });
  if (!resp.ok) {
    throw new Error(
      `[github-issues] closing ${owner}/${name}#${issueNumber} failed: ${resp.status} ${await resp.text().catch(() => "")}`.slice(0, 400),
    );
  }
}
