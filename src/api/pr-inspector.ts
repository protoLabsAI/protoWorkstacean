/**
 * POST /api/pr/inspect — GitHub PR inspection backend for Quinn.
 *
 * Wraps the GitHub REST + GraphQL APIs behind one action-shaped endpoint.
 * Authenticates as `@protoquinn[bot]` via the GitHub App credentials
 * (`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`) — reuses the same
 * shared `makeGitHubAuth` helper (`lib/github-auth.ts`). Falls back to `GITHUB_TOKEN`
 * when the App credentials aren't set.
 *
 * The `repo` argument is REQUIRED on every call. There is no default —
 * the route 400s loudly if omitted. This prevents cross-repo misrouting
 * (e.g. pulling CodeRabbit threads from the wrong repo because the
 * caller forgot the repo arg).
 *
 * Actions:
 *   list_open              → GET /repos/{owner}/{repo}/pulls
 *   check_ci               → resolves head SHA, then check-runs API
 *   coderabbit_threads     → GraphQL query for unresolved review threads
 *   diff_summary           → first 200 lines of the unified diff
 *   path_exists            → GET contents — does `path` exist in `repo`@`ref`?
 *                            (cross-repo allowed; verifies COPY/package assumptions)
 *   review_comment         → POST review with state=COMMENT
 *   review_approve         → POST review with state=APPROVE
 *   review_request_changes → POST review with state=REQUEST_CHANGES
 *   close_pr               → PATCH state=closed (optionally with a leading comment)
 *   close_pr_as_not_planned → PATCH state=closed + state_reason=not_planned
 *   reopen_pr              → PATCH state=open
 */

import type { Route, ApiContext } from "./types.ts";
import { makeGitHubAuth } from "../../lib/github-auth.ts";
import { loadFleetConfig } from "../../lib/fleet/fleet-config.ts";
import { REVIEW_TOPICS } from "../event-bus/topics.ts";
import { logger } from "../../lib/log.ts";

const log = logger("pr-inspector");

// ── Reviewer identity (fork-aware) ───────────────────────────────────────────
// Login bases (lowercased, trailing "[bot]" stripped) that identify the reviewer
// agent's OWN reviews, so `prior_review` can isolate Quinn's verdict from
// CodeRabbit / human reviews. Config-driven via fleet.yaml's reviewerBotLogins
// (default `protoquinn`). Memoized — the file is read once per process.
let _reviewerBases: string[] | undefined;
function reviewerLoginBases(): string[] {
  if (!_reviewerBases) {
    _reviewerBases = [
      ...new Set(loadFleetConfig().reviewerBotLogins.map((l) => l.toLowerCase().replace(/\[bot\]$/, ""))),
    ];
  }
  return _reviewerBases;
}
function isReviewerLogin(login: string | null | undefined): boolean {
  if (typeof login !== "string") return false;
  const l = login.toLowerCase();
  return reviewerLoginBases().some((b) => l.startsWith(b));
}

// Resolve auth lazily + memoized on first use rather than at module load.
// Module-load capture bound the getter to whatever env existed at import
// time, which (a) loses credentials injected after import — e.g. a late
// infisical pass — and (b) made the route untestable since the import order
// decided whether GITHUB_TOKEN was set. Memoizing on first call preserves
// the GitHub App's internal token cache (one getter instance reused across
// requests) while picking up the env present when the first request lands.
let _authGetter: ((owner: string, repo: string) => Promise<string>) | null | undefined;
function resolveAuth(): ((owner: string, repo: string) => Promise<string>) | null {
  if (_authGetter === undefined) _authGetter = makeGitHubAuth();
  return _authGetter;
}

/**
 * Test seam — inject an auth getter (or `null` for the no-credentials path).
 * Pass `undefined` to reset back to the lazy `makeGitHubAuth()` resolution.
 * Mirrors clawpatch.ts's `setCheckoutCacheForTesting`. Needed because the
 * onboarding suite mock.module()s `../lib/github-auth.ts` process-wide, so
 * a route test can't depend on the real resolver being in place.
 */
export function setGithubAuthForTesting(
  getter: ((owner: string, repo: string) => Promise<string>) | null | undefined,
): void {
  _authGetter = getter;
}

type Action =
  | "list_open"
  | "check_ci"
  | "coderabbit_threads"
  | "diff_summary"
  | "prior_review"
  | "path_exists"
  | "review_comment"
  | "review_approve"
  | "review_request_changes"
  | "close_pr"
  | "close_pr_as_not_planned"
  | "reopen_pr";

interface InspectRequest {
  action: Action;
  repo: string;
  pr_number?: number;
  body?: string;
  /**
   * For `path_exists`: the repo-relative path to check. The `repo` field
   * may name a DIFFERENT repo than the PR under review — that's the point,
   * it's for verifying cross-repo assumptions (a COPY-from path, a filtered
   * workspace package dir) that a diff depends on.
   */
  path?: string;
  /** For `path_exists`: optional git ref (branch/tag/sha). Defaults to the repo's default branch. */
  ref?: string;
  /**
   * When closing a PR via close_pr / close_pr_as_not_planned, optionally
   * post a comment explaining why before flipping the state. Quinn uses
   * this to link the close back to a verdict / fix-PR / triage decision.
   */
  comment?: string;
}

function parseRepo(repo: string): { owner: string; name: string } | null {
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
  const [owner, name] = repo.split("/");
  return { owner: owner!, name: name! };
}

/** Per-request timeout for GitHub calls. Beyond this, treat as a failed inspection. */
const GH_FETCH_TIMEOUT_MS = 15_000;

async function ghFetch(
  owner: string,
  name: string,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const getToken = resolveAuth();
  if (!getToken) throw new Error("no GitHub credentials (GITHUB_APP_* or GITHUB_TOKEN)");
  const token = await getToken(owner, name);
  return fetch(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(GH_FETCH_TIMEOUT_MS),
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "protoquinn",
    },
  });
}

/**
 * Verify whether a path exists in a repo at a given ref. Read-only, single
 * GitHub call — used by Quinn to check cross-repo assumptions a diff depends
 * on (a `COPY --from` source path, a filtered workspace package directory, a
 * referenced file) before assigning a verdict severity. Existence is fact;
 * an unverifiable assumption belongs in "Gaps", not a fabricated HIGH. (#3900)
 */
async function pathExists(owner: string, name: string, path: string, ref?: string): Promise<string> {
  const cleanPath = path.replace(/^\/+/, ""); // contents API is repo-relative
  const url =
    `https://api.github.com/repos/${owner}/${name}/contents/${cleanPath}` +
    (ref ? `?ref=${encodeURIComponent(ref)}` : "");
  const resp = await ghFetch(owner, name, url);
  const at = ref ? `@${ref}` : "";
  if (resp.status === 200) return `EXISTS: \`${cleanPath}\` is present in ${owner}/${name}${at}.`;
  if (resp.status === 404) {
    return `MISSING: \`${cleanPath}\` does NOT exist in ${owner}/${name}${at}. ` +
      `A diff that depends on this path (COPY source, package filter, import) is a real blocker.`;
  }
  throw new Error(`GitHub API error checking ${owner}/${name}/${cleanPath}: ${resp.status} ${await resp.text()}`);
}

async function listOpen(owner: string, name: string): Promise<string> {
  const resp = await ghFetch(
    owner,
    name,
    `https://api.github.com/repos/${owner}/${name}/pulls?state=open&per_page=30`,
  );
  if (!resp.ok) throw new Error(`GitHub API error listing PRs: ${resp.status} ${await resp.text()}`);
  const prs = (await resp.json()) as Array<{
    number: number;
    title: string;
    head: { ref: string; sha: string };
    updated_at: string;
  }>;
  if (prs.length === 0) return `No open PRs found in ${owner}/${name}.`;
  const lines = [`**${prs.length} Open PR(s) in ${owner}/${name}:**`];
  for (const pr of prs) {
    lines.push(
      `- **#${pr.number}** ${pr.title}\n  Branch: \`${pr.head.ref}\` | Updated: ${pr.updated_at.slice(0, 10)}`,
    );
  }
  return lines.join("\n");
}

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

/**
 * Raised when GitHub returns 403 on the CI read — the reviewer's token lacks
 * access to this repo/PR's checks. Most often the @protoquinn[bot] App is
 * missing the `checks:read`/`actions:read` permission, or the repo isn't in the
 * App's installation; less often a genuine fork PR or a secondary rate limit.
 * This is a reviewer-side *access* gap, NOT a CI
 * failure, so callers treat it as an unverified-CI Gap rather than a defect or
 * a hard error: `check_ci` reports it plainly, `guardTerminalCi` holds the
 * formal verdict to COMMENT. Other GitHub errors still throw loudly.
 */
class CiAccessError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "CiAccessError";
  }
}

/**
 * Resolve a PR's head SHA and fetch its check-runs. Shared by `check_ci`
 * (formats the result for Quinn) and the CI-terminal verdict guard (reads
 * the pending set). Throws `CiAccessError` on a 403 (reviewer can't see CI);
 * throws a generic Error on any other GitHub error so the caller surfaces it
 * loudly rather than treating an unknown CI state as "all clear".
 */
async function fetchCheckRuns(
  owner: string,
  name: string,
  pr: number,
): Promise<{ headSha: string; runs: CheckRun[] }> {
  const prResp = await ghFetch(owner, name, `https://api.github.com/repos/${owner}/${name}/pulls/${pr}`);
  if (prResp.status === 403) throw new CiAccessError(403, `GitHub 403 fetching PR#${pr} in ${owner}/${name} — reviewer token lacks access`);
  if (!prResp.ok) throw new Error(`GitHub API error fetching PR#${pr}: ${prResp.status} ${await prResp.text()}`);
  const { head } = (await prResp.json()) as { head: { sha: string } };

  const checksResp = await ghFetch(
    owner,
    name,
    `https://api.github.com/repos/${owner}/${name}/commits/${head.sha}/check-runs?per_page=100`,
  );
  if (checksResp.status === 403) throw new CiAccessError(403, `GitHub 403 fetching check-runs for ${owner}/${name}#${pr} — reviewer token lacks access`);
  if (!checksResp.ok) throw new Error(`GitHub API error fetching check-runs: ${checksResp.status} ${await checksResp.text()}`);
  const { check_runs } = (await checksResp.json()) as { check_runs: CheckRun[] };
  return { headSha: head.sha, runs: check_runs };
}

/**
 * Names of checks that haven't reached a terminal state yet. A check is
 * terminal once `status === "completed"` (its `conclusion` then carries the
 * pass/fail outcome). `queued` / `in_progress` / anything else = pending.
 */
function pendingCheckNames(runs: CheckRun[]): string[] {
  return runs.filter((c) => c.status !== "completed").map((c) => c.name);
}

async function checkCi(owner: string, name: string, pr: number): Promise<string> {
  let result: { headSha: string; runs: CheckRun[] };
  try {
    result = await fetchCheckRuns(owner, name, pr);
  } catch (err) {
    if (err instanceof CiAccessError) {
      return (
        `CI checks are not accessible for PR#${pr} in ${owner}/${name} (HTTP 403). ` +
        `This is a reviewer-side access gap — most likely the @protoquinn[bot] App is missing ` +
        `the checks:read/actions:read permission, or the repo isn't in the App's installation ` +
        `(less often a genuine fork PR or a secondary rate limit) — NOT a CI failure. Record it ` +
        `as an unverified-CI Gap; do not treat inaccessible CI as a broken-CI finding.`
      );
    }
    throw err;
  }
  const { headSha, runs } = result;
  return formatCheckCiResult(pr, headSha, runs);
}

/**
 * Format the `check_ci` result for Quinn. When any check is non-terminal the
 * result carries an explicit comment-and-exit directive.
 *
 * Without it Quinn busy-waits: she re-polls `check_ci` waiting for terminal CI
 * and burns the whole ReAct turn budget → recursion limit → no verdict (live:
 * ORBIS#436, a release PR whose CI runs long; the #843 escalation paged the
 * operator). There is nothing to wait for on this pass — the CI-completion
 * re-dispatch plus deterministic approve-on-green deliver the formal verdict
 * once checks settle. So the right move on pending CI is: comment once, stop.
 */
export function formatCheckCiResult(pr: number, headSha: string, runs: CheckRun[]): string {
  if (runs.length === 0) return `No CI checks found for PR#${pr} (head ${headSha.slice(0, 7)}).`;
  const lines = [`**CI Checks for PR#${pr}** (head ${headSha.slice(0, 7)}):`];
  for (const c of runs) {
    const state = c.conclusion ?? c.status;
    lines.push(`- ${c.name}: ${state}`);
  }
  const pending = pendingCheckNames(runs);
  if (pending.length > 0) {
    lines.push("");
    lines.push(
      `⏳ Non-terminal CI — ${pending.length} check(s) still running (${pending.join(", ")}). ` +
        `Submit your findings now with review_comment (non-blocking), then return your one-line ` +
        `confirmation to END the review. Do not call check_ci again to wait: a CI-completion event ` +
        `re-dispatches you for the formal PASS/FAIL once checks settle, and the merge loop auto-approves ` +
        `on terminal-green. Nothing to wait for on this pass — comment once, then stop.`,
    );
  }
  return lines.join("\n");
}

/**
 * Chokepoint invariant (#3886): a formal verdict requires terminal CI.
 *
 * APPROVE and REQUEST_CHANGES both lock in a settled judgment — APPROVE
 * enables auto-merge, REQUEST_CHANGES blocks it (sets reviewDecision).
 * While any check is still queued/in_progress, that judgment reflects a
 * timing artifact, not the PR's actual state:
 *   - a REQUEST_CHANGES "because CI is still queued" wedges the PR on a
 *     transient (#3886);
 *   - an APPROVE before CI completes lets auto-merge race a red build
 *     (#3881 incident).
 *
 * So while CI is pending, only COMMENT (non-blocking) is allowed; the
 * formal PASS/FAIL lands on a later pass once checks are terminal. Repos
 * with no checks at all are terminal by definition (nothing to wait for).
 *
 * Returns a 409 Response to reject the verdict, or null to allow it.
 * Mirrors the cooldown / target-guard / actor-filter / destructive-verdict
 * chokepoints (#437 / #444 / #459 / #465).
 */
async function guardTerminalCi(
  owner: string,
  name: string,
  pr: number,
  verdict: "APPROVE" | "REQUEST_CHANGES",
): Promise<Response | null> {
  // Throws on a GitHub error — surfaced by the route's try/catch as a 500.
  // We fail closed: an unknown CI state must never be treated as "terminal"
  // and let a verdict through (that's the #3881 failure mode).
  let runs: CheckRun[];
  try {
    ({ runs } = await fetchCheckRuns(owner, name, pr));
  } catch (err) {
    if (err instanceof CiAccessError) {
      // Reviewer can't see CI (403). We can't confirm it's terminal, so a
      // formal APPROVE/REQUEST_CHANGES would lock in a verdict on unverified
      // CI. Hold to COMMENT — same non-blocking outcome as pending CI — rather
      // than failing closed with a 500 (which the agent reads as a defect and
      // escalates to a blocking REQUEST_CHANGES).
      const verb = verdict === "APPROVE" ? "approval" : "change-request";
      return Response.json(
        {
          success: false,
          error:
            `CI is not accessible on PR#${pr} (HTTP 403) — a reviewer-side access gap (most ` +
            `likely the @protoquinn[bot] App missing checks:read/actions:read, or the repo not ` +
            `in the App's installation; less often a fork PR or rate limit), not a CI failure. ` +
            `A formal ${verb} would lock in a verdict on unverified CI, so it is held. Record ` +
            `your findings with action='review_comment' (non-blocking) and note the CI-access ` +
            `Gap; do not treat inaccessible CI as a broken-CI FAIL.`,
        },
        { status: 409 },
      );
    }
    throw err;
  }
  const pending = pendingCheckNames(runs);
  if (pending.length === 0) return null;

  log.warn(
    `CI-terminal guard: held ${verdict} on ${owner}/${name}#${pr} — ` +
      `${pending.length} check(s) still running: ${pending.slice(0, 8).join(", ")}`,
  );
  const verb = verdict === "APPROVE" ? "approval" : "change-request";
  return Response.json(
    {
      success: false,
      error:
        `CI is still running on PR#${pr} — ${pending.length} check(s) not yet complete ` +
        `(${pending.slice(0, 5).join(", ")}). A formal ${verb} would lock in a verdict on a ` +
        `timing artifact, so it is held until checks are terminal. Record interim findings now ` +
        `with action='review_comment' (non-blocking), then re-run check_ci and submit the formal ` +
        `verdict once every check has completed.`,
    },
    { status: 409 },
  );
}

async function coderabbitThreads(owner: string, name: string, pr: number): Promise<string> {
  const query = `query($owner: String!, $name: String!, $pr: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 50) {
          nodes {
            isResolved
            path
            line
            comments(first: 5) { nodes { author { login } body } }
          }
        }
      }
    }
  }`;
  const resp = await ghFetch(owner, name, "https://api.github.com/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables: { owner, name, pr } }),
  });
  if (!resp.ok) throw new Error(`GitHub API error fetching review threads: ${resp.status} ${await resp.text()}`);
  const data = (await resp.json()) as {
    errors?: Array<{ message: string }>;
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            nodes: Array<{
              isResolved: boolean;
              path: string;
              line: number | null;
              comments: { nodes: Array<{ author: { login: string } | null; body: string }> };
            }>;
          };
        };
      };
    };
  };
  if (data.errors?.length) {
    throw new Error(`GraphQL error fetching review threads: ${data.errors.map((e) => e.message).join("; ")}`);
  }
  const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  const unresolved = threads.filter((t) => !t.isResolved);
  if (unresolved.length === 0) return `No unresolved review threads on PR#${pr}.`;
  const lines = [`**${unresolved.length} Unresolved Thread(s) on PR#${pr}:**`];
  for (const [i, t] of unresolved.entries()) {
    lines.push(`\n### Thread ${i + 1}: ${t.path}:${t.line ?? "?"}`);
    for (const c of t.comments.nodes.slice(0, 3)) {
      const author = c.author?.login ?? "?";
      lines.push(`  **${author}**: ${c.body.slice(0, 300)}`);
    }
    if (t.comments.nodes.length > 3) {
      lines.push(`  _...and ${t.comments.nodes.length - 3} more comment(s)_`);
    }
  }
  return lines.join("\n");
}

// ── Structural-review (clawpatch) trigger ────────────────────────────────────
// The pr_review prompt says "run clawpatch when the diff touches >3 files, >120
// lines, or a sensitive path" — but the model had to eyeball that from a diff
// that `diff_summary` truncates at 200 lines, so on a large diff the trigger was
// literally unevaluable and clawpatch under-fired (~5% of reviews, see
// docs/explanation/code-review-agent-design.md). We compute the trigger here
// from authoritative GitHub metrics (PR JSON changed_files/additions/deletions +
// full-diff paths, neither truncated) so the directive rests on fact, not a
// guess. (#891)
const STRUCTURAL_FILE_THRESHOLD = 3; // strictly more than this many files
const STRUCTURAL_LINE_THRESHOLD = 120; // strictly more than this many changed lines

/** Paths whose change warrants a structural pass regardless of size. Mirrors the prompt's list. */
const SENSITIVE_PATH_RE =
  /(^|\/)(\.github\/|dockerfile|docker-compose|compose\.ya?ml)|(auth|session|token|crypto|oauth|password|secret|payment|billing|migrat)/i;

export interface StructuralTrigger {
  required: boolean;
  reasons: string[];
}

/** Pure decision: does this diff cross an objective structural-review trigger? Exported for testing. */
export function computeStructuralTrigger(input: {
  changedFiles: number;
  linesChanged: number;
  sensitivePaths: string[];
}): StructuralTrigger {
  const reasons: string[] = [];
  if (input.changedFiles > STRUCTURAL_FILE_THRESHOLD) {
    reasons.push(`${input.changedFiles} files changed (> ${STRUCTURAL_FILE_THRESHOLD})`);
  }
  if (input.linesChanged > STRUCTURAL_LINE_THRESHOLD) {
    reasons.push(`${input.linesChanged} lines changed (> ${STRUCTURAL_LINE_THRESHOLD})`);
  }
  if (input.sensitivePaths.length > 0) {
    reasons.push(`sensitive path(s): ${input.sensitivePaths.slice(0, 5).join(", ")}`);
  }
  return { required: reasons.length > 0, reasons };
}

/** Repo-relative paths touched by a unified diff, parsed from its `diff --git` headers. */
function changedPathsFromDiff(diff: string): string[] {
  const paths = new Set<string>();
  for (const line of diff.split("\n")) {
    const m = /^diff --git a\/.+? b\/(.+)$/.exec(line);
    if (m?.[1]) paths.add(m[1]);
  }
  return [...paths];
}

async function diffSummary(owner: string, name: string, pr: number): Promise<string> {
  // Authoritative change metrics — the PR JSON carries totals that survive the
  // 200-line preview truncation below, so the structural trigger is evaluated on
  // the whole diff, not just what fits in the preview.
  const metaResp = await ghFetch(owner, name, `https://api.github.com/repos/${owner}/${name}/pulls/${pr}`);
  let changedFiles = 0;
  let additions = 0;
  let deletions = 0;
  if (metaResp.ok) {
    const m = (await metaResp.json()) as { changed_files?: number; additions?: number; deletions?: number };
    changedFiles = m.changed_files ?? 0;
    additions = m.additions ?? 0;
    deletions = m.deletions ?? 0;
  }

  const getToken = resolveAuth();
  if (!getToken) throw new Error("no GitHub credentials (GITHUB_APP_* or GITHUB_TOKEN)");
  const token = await getToken(owner, name);
  const resp = await fetch(`https://api.github.com/repos/${owner}/${name}/pulls/${pr}`, {
    signal: AbortSignal.timeout(GH_FETCH_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3.diff",
      "User-Agent": "protoquinn",
    },
  });
  if (!resp.ok) throw new Error(`GitHub API error fetching diff: ${resp.status} ${await resp.text()}`);
  const diff = await resp.text();
  const lines = diff.split("\n");
  const truncated = lines.length > 200;
  const preview = lines.slice(0, 200).join("\n");
  const suffix = truncated ? `\n\n_...truncated (${lines.length} total lines)_` : "";

  // Sensitive-path detection runs over the FULL diff (only the preview is
  // truncated), so it's complete even on a large PR.
  const sensitivePaths = changedPathsFromDiff(diff).filter((p) => SENSITIVE_PATH_RE.test(p));
  const trigger = computeStructuralTrigger({ changedFiles, linesChanged: additions + deletions, sensitivePaths });
  const directive = trigger.required
    ? `**STRUCTURAL REVIEW REQUIRED** — this diff crosses the objective trigger (${trigger.reasons.join("; ")}). ` +
      `Run \`clawpatch_review\` before issuing your verdict; skipping the structural pass on a triggered diff is a Gap.`
    : `**Structural review optional** — small contained diff (${changedFiles} file(s), ${additions + deletions} line(s) changed); \`clawpatch_review\` not required.`;

  return (
    `**Diff for PR#${pr}** (${changedFiles} files, +${additions}/-${deletions}):\n\n` +
    `${directive}\n\n\`\`\`diff\n${preview}\n\`\`\`${suffix}`
  );
}

/**
 * Recall the reviewer's OWN most-recent verdict on a PR so a re-review is
 * incremental, not a cold start (re-review memory). Quinn re-reviews the whole
 * PR from scratch every CI cycle today — no memory of her prior verdict — which
 * both re-litigates settled findings and is a prime cause of the recursion-limit
 * thrash. Her findings live in the review *body* (an Observations section), not
 * inline threads, so the ground-truth recall is that prior verdict body plus the
 * SHA it was submitted against. Comparing the reviewed SHA to the current head
 * tells her whether there is a code delta to re-review or the cycle is just CI
 * settling. GitHub is the source of truth — no local store to drift.
 */
async function priorReview(owner: string, name: string, pr: number): Promise<string> {
  // Current head SHA — to detect whether the code moved since the last review.
  // Recall is advisory: a 403 (reviewer can't see the PR) degrades to "no
  // recall — do a full review", never a hard error that derails the review.
  const prResp = await ghFetch(owner, name, `https://api.github.com/repos/${owner}/${name}/pulls/${pr}`);
  if (prResp.status === 403) {
    return `Prior review not accessible for PR#${pr} in ${owner}/${name} (HTTP 403) — proceed with a full review.`;
  }
  if (!prResp.ok) throw new Error(`GitHub API error fetching PR#${pr}: ${prResp.status} ${await prResp.text()}`);
  const headSha = ((await prResp.json()) as { head?: { sha?: string } }).head?.sha ?? "";

  const reviewsResp = await ghFetch(
    owner,
    name,
    `https://api.github.com/repos/${owner}/${name}/pulls/${pr}/reviews?per_page=100`,
  );
  if (!reviewsResp.ok) throw new Error(`GitHub API error fetching reviews: ${reviewsResp.status} ${await reviewsResp.text()}`);
  const reviews = (await reviewsResp.json()) as Array<{
    user: { login: string } | null;
    state: string;
    body: string;
    commit_id: string | null;
    submitted_at: string | null;
  }>;

  // GitHub returns reviews oldest-first; the last reviewer-authored verdict wins.
  let last: (typeof reviews)[number] | undefined;
  for (const r of reviews) {
    if (isReviewerLogin(r.user?.login) && ["COMMENTED", "APPROVED", "CHANGES_REQUESTED"].includes(r.state)) {
      last = r;
    }
  }

  if (!last) {
    return (
      `No prior review by you on PR#${pr} — this is your FIRST pass. ` +
      `Gather full evidence (Step 2) and review the whole diff.`
    );
  }

  const reviewedSha = last.commit_id ?? "";
  const moved = reviewedSha !== "" && headSha !== "" && reviewedSha !== headSha;
  const when = last.submitted_at ? last.submitted_at.slice(0, 10) : "?";
  const lines: string[] = [
    `**Your prior verdict on PR#${pr}: ${last.state}** (submitted ${when} against \`${reviewedSha.slice(0, 7) || "?"}\`).`,
    moved
      ? `The head has since advanced to \`${headSha.slice(0, 7)}\`. This is an INCREMENTAL re-review: focus on what changed since \`${reviewedSha.slice(0, 7)}\` and check whether the findings in your prior verdict were addressed — carry forward the ones still open, drop the ones now fixed. Do not re-derive findings whose code is unchanged.`
      : `The head is unchanged (\`${headSha.slice(0, 7)}\`) — no new commits since your last review. This cycle is CI settling, not new code: reaffirm your prior verdict rather than re-deriving it (a clean prior review promotes to APPROVED automatically once CI is terminal-green).`,
  ];
  if (last.body && last.body.trim()) {
    lines.push(`\nYour prior verdict body (reuse the findings still in scope):\n${last.body.slice(0, 1200)}`);
  }
  return lines.join("\n");
}

/**
 * Fire-and-forget bus notification that Quinn just submitted a formal
 * review. Subscribers (today: quinn-review-notifier-plugin for Discord
 * embeds) react to specific verdicts. Failure to publish must never
 * cascade into the route handler — caller already returned a successful
 * GitHub API result by the time this runs.
 */
function publishReviewSubmitted(
  ctx: ApiContext,
  owner: string,
  name: string,
  pr: number,
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  body: string,
): void {
  try {
    const correlationId = crypto.randomUUID();
    ctx.bus.publish(REVIEW_TOPICS.QUINN_REVIEW_SUBMITTED, {
      id: crypto.randomUUID(),
      correlationId,
      topic: REVIEW_TOPICS.QUINN_REVIEW_SUBMITTED,
      timestamp: Date.now(),
      payload: {
        owner,
        repo: name,
        prNumber: pr,
        event,
        prUrl: `https://github.com/${owner}/${name}/pull/${pr}`,
        bodyPreview: body.slice(0, 600),
      },
    });
  } catch (err) {
    log.warn("failed to publish quinn.review.submitted", { err });
  }
}

async function submitReview(
  owner: string,
  name: string,
  pr: number,
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  body: string,
): Promise<string> {
  const resp = await ghFetch(
    owner,
    name,
    `https://api.github.com/repos/${owner}/${name}/pulls/${pr}/reviews`,
    {
      method: "POST",
      body: JSON.stringify({ event, body: body || (event === "APPROVE" ? "Approved by Quinn QA." : body) }),
      headers: { "Content-Type": "application/json" },
    },
  );
  if (!resp.ok) throw new Error(`GitHub API error submitting review: ${resp.status} ${await resp.text()}`);
  const label = event === "APPROVE" ? "Approved" : event === "REQUEST_CHANGES" ? "Requested changes on" : "Commented on";
  return `${label} PR#${pr} in ${owner}/${name}.`;
}

async function postIssueComment(owner: string, name: string, n: number, body: string): Promise<void> {
  const resp = await ghFetch(
    owner,
    name,
    `https://api.github.com/repos/${owner}/${name}/issues/${n}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body }),
      headers: { "Content-Type": "application/json" },
    },
  );
  if (!resp.ok) throw new Error(`GitHub API error posting comment on #${n}: ${resp.status} ${await resp.text()}`);
}

/**
 * Flip a PR's state. GitHub uses the same /pulls/{n} PATCH endpoint for
 * close + reopen via `state: "closed" | "open"`. PRs that are merged
 * cannot be reopened — this surfaces as a 422 from GitHub. We let that
 * bubble up so Quinn can fold the failure into her observation list.
 *
 * `state_reason` distinguishes the close motive on PRs the same way
 * GitHub does for issues — "completed" (default) vs "not_planned"
 * (closed without merging because it's stale / superseded / wrong
 * approach). Quinn uses not_planned when the PR's underlying request
 * has been resolved a different way.
 */
async function setPrState(
  owner: string,
  name: string,
  pr: number,
  state: "open" | "closed",
  comment: string | undefined,
  notPlanned = false,
): Promise<string> {
  // Drop the comment first so observers see the rationale before the
  // state-change webhook fires. Failure to comment is non-fatal — log
  // and proceed to the state change.
  if (comment && comment.trim()) {
    try {
      await postIssueComment(owner, name, pr, comment);
    } catch (e) {
      log.warn(`comment-then-close: comment failed (proceeding): ${String(e).slice(0, 300)}`);
    }
  }

  const body: Record<string, unknown> = { state };
  if (state === "closed" && notPlanned) body.state_reason = "not_planned";

  const resp = await ghFetch(
    owner,
    name,
    `https://api.github.com/repos/${owner}/${name}/pulls/${pr}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    },
  );
  if (!resp.ok) {
    throw new Error(`GitHub API error setting PR#${pr} state=${state}: ${resp.status} ${await resp.text()}`);
  }
  const verb = state === "open" ? "Reopened" : notPlanned ? "Closed (not planned)" : "Closed";
  return `${verb} PR#${pr} in ${owner}/${name}.`;
}

export function createRoutes(ctx: ApiContext): Route[] {
  return [
    {
      method: "POST",
      path: "/api/pr/inspect",
      handler: async (req) => {
        let payload: InspectRequest;
        try {
          payload = (await req.json()) as InspectRequest;
        } catch {
          return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });
        }

        const { action, repo, pr_number, body, comment, path, ref } = payload;
        if (!action || !repo) {
          return Response.json(
            { success: false, error: "action and repo are required" },
            { status: 400 },
          );
        }
        const parsed = parseRepo(repo);
        if (!parsed) {
          return Response.json(
            { success: false, error: `repo must be in owner/name format, got '${repo}'` },
            { status: 400 },
          );
        }
        const { owner, name } = parsed;

        const needsPr: Action[] = [
          "check_ci",
          "coderabbit_threads",
          "diff_summary",
          "prior_review",
          "review_comment",
          "review_approve",
          "review_request_changes",
          "close_pr",
          "close_pr_as_not_planned",
          "reopen_pr",
        ];
        if (needsPr.includes(action) && (typeof pr_number !== "number" || !Number.isInteger(pr_number))) {
          return Response.json(
            { success: false, error: `pr_number is required (integer) for action='${action}'` },
            { status: 400 },
          );
        }
        if (action === "path_exists" && (typeof path !== "string" || !path.trim())) {
          return Response.json(
            { success: false, error: "path is required (non-empty string) for action='path_exists'" },
            { status: 400 },
          );
        }

        try {
          let result: string;
          switch (action) {
            case "list_open":
              result = await listOpen(owner, name);
              break;
            case "path_exists":
              result = await pathExists(owner, name, path!, ref);
              break;
            case "check_ci":
              result = await checkCi(owner, name, pr_number!);
              break;
            case "coderabbit_threads":
              result = await coderabbitThreads(owner, name, pr_number!);
              break;
            case "diff_summary":
              result = await diffSummary(owner, name, pr_number!);
              break;
            case "prior_review":
              result = await priorReview(owner, name, pr_number!);
              break;
            case "review_comment":
              if (!body) {
                return Response.json({ success: false, error: "body required for review_comment" }, { status: 400 });
              }
              result = await submitReview(owner, name, pr_number!, "COMMENT", body);
              publishReviewSubmitted(ctx, owner, name, pr_number!, "COMMENT", body);
              break;
            case "review_approve": {
              const held = await guardTerminalCi(owner, name, pr_number!, "APPROVE");
              if (held) return held;
              result = await submitReview(owner, name, pr_number!, "APPROVE", body ?? "");
              publishReviewSubmitted(ctx, owner, name, pr_number!, "APPROVE", body ?? "");
              break;
            }
            case "review_request_changes": {
              if (!body) {
                return Response.json({ success: false, error: "body required for review_request_changes" }, { status: 400 });
              }
              const held = await guardTerminalCi(owner, name, pr_number!, "REQUEST_CHANGES");
              if (held) return held;
              result = await submitReview(owner, name, pr_number!, "REQUEST_CHANGES", body);
              publishReviewSubmitted(ctx, owner, name, pr_number!, "REQUEST_CHANGES", body);
              break;
            }
            case "close_pr":
              result = await setPrState(owner, name, pr_number!, "closed", comment, false);
              break;
            case "close_pr_as_not_planned":
              result = await setPrState(owner, name, pr_number!, "closed", comment, true);
              break;
            case "reopen_pr":
              result = await setPrState(owner, name, pr_number!, "open", comment, false);
              break;
            default:
              return Response.json({ success: false, error: `unknown action '${action}'` }, { status: 400 });
          }
          return Response.json({ success: true, data: { result } });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Response.json({ success: false, error: message }, { status: 500 });
        }
      },
    },
  ];
}
