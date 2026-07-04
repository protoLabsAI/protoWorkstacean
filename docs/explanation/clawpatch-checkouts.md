---
title: Clawpatch checkouts — on-demand source for any repo
---

_RFC + design for the checkout cache that lets Quinn's `clawpatch_review` work against every repo in the project registry, not just the few that used to be bind-mounted into the container. Shipped: `src/api/clawpatch.ts` now resolves repos through a `CheckoutCache` gated by the project registry — there is no `BUILT_IN_REPO_PATHS` and no `projects.yaml`._

---

## Problem

`POST /api/clawpatch/review` runs `clawpatch ci --provider gateway --json` inside a path resolved by `resolveRepoPath(repo)` in [`src/api/clawpatch.ts`](../../src/api/clawpatch.ts). Today that resolver consults exactly two sources:

1. The `CLAWPATCH_REPO_PATH_MAP` env (JSON override).
2. A hard-coded `BUILT_IN_REPO_PATHS` map of ~9 repos that the homelab compose file bind-mounts read-only into the workstacean container.

A repo without an entry — or with an entry whose mount the operator forgot to add to the compose file — gets a hard error: _"repo 'X' is not mounted in this container — only mapped+mounted repos work today (…). On-demand PR checkouts are not implemented."_

That ceiling is everywhere Quinn touches a repo she didn't grow up with. As we keep onboarding repos (every entry in the project registry is a candidate), the gap widens: edit compose, redeploy, then she can review it. Worse, the mount is a snapshot of the operator's local checkout, not the PR's actual code — Quinn was technically reviewing whatever ref happened to be checked out on the host, not the PR head.

We want a self-service checkout cache: when Quinn asks to review a PR on a repo she's never seen, the API fetches the exact ref from GitHub, extracts it locally, hands the path to clawpatch, and caches the extracted tree for the next call.

---

## Source of truth: git partial clone

Each cache entry is a real **git working tree** checked out at the PR head, because clawpatch scopes its review with `git diff <base>` and needs git history to resolve the base ref. (An earlier design extracted GitHub tarballs; that had no `.git`, so `clawpatch ci --since <base>` crashed with "not a git repository" — the review silently fell back to nothing. See the 2026-07-04 smoke-test fix.)

Materialization is a **blob-filtered partial clone** (`git clone --filter=blob:none`) followed by an explicit `git fetch origin <headSha>` (covers detached PR/fork heads) and `git checkout <headSha>`:

- All commit + tree objects come down, so any base ref a later `git diff` names resolves from local history. Blobs are fetched lazily — the checkout pulls the head tree's files, and a `git diff <base>` pulls the base tree's — in a couple of batched requests, not per-file.
- The clone URL embeds the short-lived (~1h) GitHub App installation token so those lazy fetches keep authenticating. The token lands in the entry's `.git/config`; the 1h cache TTL is aligned with the token lifetime, so a stale token forces a re-clone anyway.

Auth uses the existing `makeGitHubAuth()` helper — same App credentials that file issues, post review comments, and read PR data. No new credential surface.

---

## Cache layout

Content-addressed by ref, one tree per (owner, repo, sha):

```
/data/checkouts/
  protoLabsAI-escape-from-qud/
    f3a91c8b…/           ← extracted tree
      package.json
      src/
      …
    last-access          ← ISO timestamp, updated on hit
  protoLabsAI-protoContent/
    a17e..../
      …
```

Path shape: `${DATA_DIR}/checkouts/<owner>-<repo>/<sha>/`. Same `<owner>-<repo>` slug shape that `stateDirFor()` already uses for the clawpatch state root — keeps the two volumes' layouts consistent.

The cache dir is created lazily on first checkout. `DATA_DIR` defaults to `/data` (same as clawpatch state), overridable for tests via the same `CLAWPATCH_STATE_ROOT` style — propose `CLAWPATCH_CHECKOUT_ROOT`.

A `last-access` file (touched on every hit) is the LRU clock. Cheaper than restating directories during eviction sweeps.

---

## Cache invalidation

Two independent triggers — whichever fires first:

* **Size cap**: 5 GB total under `/data/checkouts/`. When exceeded after a new extract, evict by `last-access` ascending until back under the limit.
* **Entry cap**: 50 entries. Same eviction policy.

Why two: a single ~100 MB monorepo checkout could blow the size budget alone; a flurry of small repos could blow the entry budget without hitting the size budget. Both are escape valves for "the disk is going to fill up tonight, and I'd rather drop old checkouts than crash."

**TTL refresh**: an extracted tree is "fresh" for 24 hours. After that the resolver re-fetches even if the cache hit is for the exact SHA. That covers the case where a PR is rebased mid-review and the base branch drifts — clawpatch's diff is anchored to a base, and `--since base_sha` against a stale base would lie about what changed. 24h is a heuristic; happy to dial down to 1h if we observe drift complaints. (24h was picked over "always re-fetch" because most reviews land within an hour of opening — keeping the warm path warm is worth the small staleness risk.)

Eviction lives in a daily ceremony, **not** inline on each request — see [C3](#c3-cache-cleanup-ceremony). Inline eviction adds tail latency to every review call.

---

## Security

The trust boundary is the **allowlist gate**: `repo` must match a GitHub coordinate in the **project registry** (`projectRegistry.getGithubCoords()` in `src/api/clawpatch.ts`) — the same boundary that `create_github_issue` checks, and it runs *before* any GitHub call. No arbitrary `owner/name` from a tool call gets cloned into our data volume; Quinn only ever clones repos we've already declared we manage. Because every cloned repo is one we own, there is no untrusted-tree threat model — the elaborate tarball-entry sanitization (path traversal, symlink, oversize) the tarball design needed is gone with the tarball. Git handles its own checkout; a repo we own that tracks a symlink is fine.

The PR head + base SHAs are resolved server-side from GitHub (`resolvePrRefs`), never taken from the caller — an agent can't strand or redirect the review onto a hallucinated ref.

---

## Concurrency

Per-(repo, sha) extraction mutex. If two reviews of the same PR head arrive within seconds of each other (Quinn re-checking after a comment, or two ceremonies firing on overlapping windows), the second waits for the first's extract to finish rather than racing on the same directory.

Implemented as an in-memory `Map<string, Promise<string>>` in `lib/checkout-cache.ts` — the key is `${repo}@${sha}`, the value is the extract promise. Cleared from the map on settle (resolve or reject). Single-node only — when we go multi-node ([Multi-node](architecture.md) in the architecture doc), the second node would re-extract, which is wasteful but safe (content-addressed).

---

## Public API

```ts
// lib/checkout-cache.ts
export interface CheckoutCache {
  /**
   * Resolve a local git-checkout path for (repo, headSha). Returns the
   * cached path if one exists and is fresh (< 1h); otherwise git-clones +
   * checks out the head under /data/checkouts/<owner>-<repo>/<sha>/ and
   * returns the new path. Touches mtime on hit.
   *
   * Throws if the clone/checkout fails. Caller enforces the project-registry
   * allowlist before calling.
   */
  resolve(repo: string, headSha: string): Promise<string>;

  /**
   * Prune the cache by both size and entry limits. Returns counts.
   * Called from a daily ceremony, not inline.
   */
  prune(): Promise<{ evicted: number; bytesFreed: number }>;
}
```

As shipped, `POST /api/clawpatch/review` takes `{ repo, pr }`. `resolvePrRefs(owner, name, pr)` reads the PR's `head.sha` (the tree to review) and `base.sha` (the `--since` diff anchor) from GitHub, then `resolveHeadCheckout` routes the head through the project-registry allowlist gate and the `CheckoutCache` — there is no `BUILT_IN_REPO_PATHS` bind-mount fast path (see the sign-off decision below). The only local-dev escape hatch is the `CLAWPATCH_REPO_PATH_MAP` override; everything else clones the head on demand:

```ts
// roughly:
const { headSha, baseSha } = await resolvePrRefs(owner, name, pr);   // from GitHub, not the caller
const allow = new Set(projectRegistry?.getGithubCoords() ?? []);
if (!allow.has(repo)) { /* reject — not a managed repo */ }
const override = readOverrideMap()[repo];
const repoPath = (override && existsSync(override))
  ? override                                                        // local-dev only
  : await getCheckoutCache().resolve(repo, headSha);                 // on-demand git checkout
// clawpatch ci … --since <baseSha>  → review scoped to what the PR changed
```

The caller passes only the PR number; the route derives head + base itself, so the review is always anchored to the PR's real refs and scoped to exactly the features it touched.

---

## What this isn't

* Not a full clone. Blob-filtered (`--filter=blob:none`): commit + tree history is present so `git diff <base>` resolves, but file blobs are fetched lazily. Enough git for diff-scoping; not a mirror.
* Not a build cache. We don't run `npm install` / `pnpm install` / `bun install` after checkout. Clawpatch reviews source; if a future provider needs node_modules, that's a separate problem.
* Not a writable workspace. clawpatch reads the checked-out tree; review state still goes under `${CLAWPATCH_STATE_ROOT}/<owner>-<repo>/`, untouched by the cache evictor.
* Not multi-tenant. One operator's workstacean serves one fleet; the cache is single-volume and not shared cross-node.

---

## Rollout

* **C1** (this doc, 2 pts) — RFC, sign-off.
* **C2** — `lib/checkout-cache.ts` + resolver wire-up + unit tests (LRU eviction, traversal rejection, oversize refusal, concurrency). 5 pts.
* **C3** — `workspace/ceremonies/clawpatch-cache-cleanup.yaml` calling `checkoutCache.prune()` daily at 03:00 UTC via a function executor. 3 pts.
* **C4** — Drop the "v1 only handles three repos" caveat from Quinn's `pr_review` prompt; drop `BUILT_IN_REPO_PATHS` entirely so every repo routes through the cache. 3 pts.

Total: 13 pts.

After C4, hard-coded repo paths are gone from production. Every repo — including the ones that used to be bind-mounted — routes through GitHub-tarball + extract. The only escape hatch is `CLAWPATCH_REPO_PATH_MAP` for local dev (pointing at a working tree on disk), never set in the deployed container.

## Resolved decisions (sign-off on #578)

Per "better way over fast way":

1. **No bind-mount fast path. No cache pinning.** Drop `BUILT_IN_REPO_PATHS` entirely. Every repo, including `protoWorkstacean` / `protoCLI` / `mythxengine`, routes through the checkout cache. The fast path was buying us "skip extract IO for three repos" at the cost of a real correctness ambiguity — "did Quinn review the host's checkout or the PR's actual ref?" — and a dual-code-path operator model. Consistency wins.
2. **TTL: 1h, not 24h.** SHA-keyed content-addressing means correctness is fine at any TTL — this is purely a "freshness over warm-cache hit-rate" choice. An hour amortizes the review-comment burst case (same PR head re-reviewed several times in quick succession) without holding stale source long enough to risk base-branch drift hiding review-relevant changes.

## Open questions

* **GitHub tarball rate limits**: App credentials get 15k req/hr, and a tarball is 1 req. We'd need to be reviewing >4 PRs/sec to feel it. Not a real constraint at fleet size. Note but don't gate on it.

