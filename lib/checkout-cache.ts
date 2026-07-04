/**
 * CheckoutCache — content-addressed git-checkout cache for clawpatch.
 *
 * Backs `src/api/clawpatch.ts` so structural review works against every
 * repo in the project registry. Each entry is a real **git working tree**
 * checked out at the PR head SHA — not a tarball extraction — because
 * clawpatch scopes its review with `git diff <base>` and needs git history
 * to resolve the base ref. A successful checkout lands at
 * `${CHECKOUT_ROOT}/<owner>-<repo>/<sha>/`.
 *
 * Materialization is a **blob-filtered partial clone** (`--filter=blob:none`)
 * followed by `git checkout <headSha>`:
 *   - All commit + tree objects are fetched, so any base ref the caller
 *     passes to `git diff` resolves. Blobs are fetched lazily (checkout
 *     pulls the head tree's files; a later `git diff <base>` pulls the base
 *     tree's) in a couple of batched requests, not per-file.
 *   - The clone URL embeds the short-lived (≈1h) GitHub App installation
 *     token so lazy blob fetches keep working for the entry's lifetime. The
 *     token lands in the entry's `.git/config`; the 1h cache TTL is aligned
 *     with the token lifetime, so a stale token forces a re-clone anyway.
 *
 * Design notes live in docs/explanation/clawpatch-checkouts.md (C1):
 *   - LRU eviction at 5 GB OR 50 entries, whichever first.
 *   - 1h TTL refresh: per the C1 sign-off — "better way over fast way".
 *   - Per-(repo, sha) clone mutex: simultaneous reviews on the same PR head
 *     queue rather than racing.
 *   - Security: project-registry allowlist (enforced by the caller). Only
 *     repos we own are ever cloned — there is no untrusted-repo path.
 *
 * Eviction lives in `prune()`, invoked from a daily ceremony (C3). The hot
 * path never sweeps — inline eviction would add unpredictable tail latency
 * to every review call.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "./log.ts";

const log = logger("checkout-cache");

const DEFAULT_CHECKOUT_ROOT =
  process.env["CLAWPATCH_CHECKOUT_ROOT"] ??
  join(process.env["DATA_DIR"] ?? "/data", "checkouts");

const DEFAULT_SIZE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const DEFAULT_ENTRY_LIMIT = 50;
// 1h TTL. SHA-keyed content-addressing makes correctness fine at any TTL;
// this picks "fresh" over "warm-cache hit-rate". An hour amortizes the
// review-comment burst case (same PR head re-reviewed several times in
// quick succession) without holding stale source long enough to risk
// base-branch drift hiding review-relevant changes, and matches the ~1h
// GitHub App token lifetime baked into the clone URL. Per C1 sign-off (#578).
const DEFAULT_TTL_MS = 60 * 60 * 1000;

export interface CheckoutCacheConfig {
  root?: string;
  sizeLimitBytes?: number;
  entryLimit?: number;
  ttlMs?: number;
  /**
   * Override for the GitHub auth-token getter. Defaults to a thunk that
   * returns the `GITHUB_TOKEN` env var so the cache can be exercised in
   * tests without the App-auth stack.
   */
  getToken?: (owner: string, repo: string) => Promise<string>;
  /**
   * Override the actual git clone — tests inject a stub that populates the
   * target dir from a fixture rather than hitting github.com.
   */
  cloneRepo?: (
    owner: string,
    repo: string,
    headSha: string,
    token: string,
    targetDir: string,
  ) => Promise<void>;
}

interface ResolvedConfig {
  root: string;
  sizeLimitBytes: number;
  entryLimit: number;
  ttlMs: number;
  getToken: (owner: string, repo: string) => Promise<string>;
  cloneRepo: (
    owner: string,
    repo: string,
    headSha: string,
    token: string,
    targetDir: string,
  ) => Promise<void>;
}

export class CheckoutCache {
  private readonly cfg: ResolvedConfig;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(config: CheckoutCacheConfig = {}) {
    const getToken =
      config.getToken ??
      (async () => {
        const tok = process.env.GITHUB_TOKEN;
        if (!tok) throw new Error("CheckoutCache: no GITHUB_TOKEN and no getToken override");
        return tok;
      });
    this.cfg = {
      root: config.root ?? DEFAULT_CHECKOUT_ROOT,
      sizeLimitBytes: config.sizeLimitBytes ?? DEFAULT_SIZE_LIMIT_BYTES,
      entryLimit: config.entryLimit ?? DEFAULT_ENTRY_LIMIT,
      ttlMs: config.ttlMs ?? DEFAULT_TTL_MS,
      getToken,
      cloneRepo: config.cloneRepo ?? defaultCloneRepo,
    };
  }

  /**
   * Resolve a local git-checkout path for (repo, sha). Returns cache hit
   * if present and fresh; otherwise clones + checks out. Throws on any
   * git / IO failure — never returns null.
   *
   * `repo` is "owner/name". `sha` is the PR head SHA — the tree to review.
   * Caller is responsible for enforcing the project-registry allowlist
   * before calling — this layer trusts its input.
   */
  async resolve(repo: string, sha: string): Promise<string> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(`CheckoutCache: invalid repo shape '${repo}', expected owner/name`);
    }
    if (!/^[a-f0-9]{7,40}$/i.test(sha)) {
      throw new Error(`CheckoutCache: invalid sha '${sha}', expected hex ref`);
    }
    const key = `${repo}@${sha}`;
    const existingClone = this.inflight.get(key);
    if (existingClone) return existingClone;

    const promise = this._resolveImpl(repo, sha);
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async _resolveImpl(repo: string, sha: string): Promise<string> {
    const dir = this._dirFor(repo, sha);
    if (existsSync(dir)) {
      const age = Date.now() - statSync(dir).mtimeMs;
      if (age < this.cfg.ttlMs) {
        const now = new Date();
        utimesSync(dir, now, now);
        log.info(
          `hit ${repo}@${sha.slice(0, 7)} (age ${(age / 60_000).toFixed(1)}m)`,
        );
        return dir;
      }
      log.info(
        `stale ${repo}@${sha.slice(0, 7)} (age ${(age / 60_000).toFixed(1)}m > ttl) — re-cloning`,
      );
      rmSync(dir, { recursive: true, force: true });
    }

    const [owner, name] = repo.split("/");
    const token = await this.cfg.getToken(owner, name);
    // git clone creates the leaf dir itself; make sure the <slug>/ parent exists.
    mkdirSync(dirname(dir), { recursive: true });
    try {
      await this.cfg.cloneRepo(owner, name, sha, token, dir);
    } catch (err) {
      // Don't leave a half-cloned tree around — the next resolve() would
      // mistake it for a cache hit.
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
    log.info(`miss ${repo}@${sha.slice(0, 7)} cloned + checked out`);
    return dir;
  }

  /**
   * Prune the cache. Called from the daily ceremony — NOT from the hot path.
   * Drops entries whose mtime is older than the TTL, then evicts by
   * least-recently-accessed until under both size and entry caps.
   */
  async prune(): Promise<{ evicted: number; bytesFreed: number }> {
    if (!existsSync(this.cfg.root)) return { evicted: 0, bytesFreed: 0 };

    interface Entry { path: string; mtimeMs: number; bytes: number }
    const entries: Entry[] = [];
    for (const slug of readdirSync(this.cfg.root)) {
      const slugDir = join(this.cfg.root, slug);
      if (!statSync(slugDir).isDirectory()) continue;
      for (const sha of readdirSync(slugDir)) {
        const entryDir = join(slugDir, sha);
        const st = statSync(entryDir);
        if (!st.isDirectory()) continue;
        entries.push({ path: entryDir, mtimeMs: st.mtimeMs, bytes: dirSizeBytes(entryDir) });
      }
    }

    const now = Date.now();
    let evicted = 0;
    let bytesFreed = 0;

    // Drop anything past TTL outright — saves the LRU scan from juggling stale entries.
    const fresh: Entry[] = [];
    for (const e of entries) {
      if (now - e.mtimeMs > this.cfg.ttlMs) {
        rmSync(e.path, { recursive: true, force: true });
        evicted++;
        bytesFreed += e.bytes;
      } else {
        fresh.push(e);
      }
    }

    // LRU eviction: sort by mtimeMs asc, evict until both caps satisfied.
    fresh.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let totalBytes = fresh.reduce((acc, e) => acc + e.bytes, 0);
    while (
      fresh.length > 0 &&
      (fresh.length > this.cfg.entryLimit || totalBytes > this.cfg.sizeLimitBytes)
    ) {
      const victim = fresh.shift()!;
      rmSync(victim.path, { recursive: true, force: true });
      evicted++;
      bytesFreed += victim.bytes;
      totalBytes -= victim.bytes;
    }

    if (evicted > 0) {
      log.info(
        `pruned ${evicted} entr${evicted === 1 ? "y" : "ies"} (${bytesFreed} bytes)`,
      );
    }
    return { evicted, bytesFreed };
  }

  private _dirFor(repo: string, sha: string): string {
    const slug = repo.replace("/", "-");
    return join(this.cfg.root, slug, sha);
  }
}

/**
 * Blob-filtered partial clone of a repo we own, checked out at `headSha`.
 * The token is embedded in the remote URL so git's lazy blob fetches (during
 * checkout and any later `git diff <base>`) authenticate. `GIT_TERMINAL_PROMPT=0`
 * makes a bad/expired token fail fast instead of hanging on a credential prompt.
 */
async function defaultCloneRepo(
  owner: string,
  repo: string,
  headSha: string,
  token: string,
  targetDir: string,
): Promise<void> {
  const url = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
  // Clone all branch tips (blobless) so any base ref a later `git diff` names
  // resolves from local history. `--no-checkout` skips materializing the
  // default branch — with blob:none that would lazily fetch its whole blob
  // set, only to be replaced by the head checkout below.
  await runGit(["clone", "--filter=blob:none", "--no-checkout", "--no-tags", "--quiet", url, targetDir]);
  // The head commit may be a detached PR ref or a fork head not covered by the
  // branch fetch above — fetch it explicitly by SHA (GitHub serves PR heads via
  // allowAnySHA1InWant). Best-effort: when the clone already has the commit
  // (same-repo branch head), the checkout below is the real gate, so a fetch
  // miss here shouldn't abort.
  try {
    await runGit(["-C", targetDir, "fetch", "--filter=blob:none", "--no-tags", "--quiet", "origin", headSha]);
  } catch (err) {
    log.info(
      `explicit head fetch for ${owner}/${repo}@${headSha.slice(0, 7)} failed (${err instanceof Error ? err.message : String(err)}) — relying on the clone's refs`,
    );
  }
  await runGit(["-C", targetDir, "checkout", "--quiet", headSha]);
}

// A stalled network clone/fetch must not hang forever: `resolve()` holds the
// (repo, sha) key in `inflight` until the git promise settles, so a pending
// git would make every retry for that PR head wait on the same dead promise.
const GIT_TIMEOUT_MS = 3 * 60 * 1000;

function runGit(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, GIT_TIMEOUT_MS);
    proc.stdout.on("data", chunk => { stdout += String(chunk); });
    proc.stderr.on("data", chunk => { stderr += String(chunk); });
    proc.on("error", err => { clearTimeout(timer); reject(err); });
    proc.on("close", code => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`git ${redactToken(args.join(" "))} timed out after ${GIT_TIMEOUT_MS}ms`));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        // Redact the token if it leaked into an error line before surfacing.
        reject(new Error(`git ${redactToken(args.join(" "))} exited ${code}: ${redactToken(stderr.trim())}`));
      }
    });
  });
}

/** Strip an embedded `x-access-token:<tok>@` credential from any string. */
function redactToken(s: string): string {
  return s.replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
}

function dirSizeBytes(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) total += dirSizeBytes(p);
    else total += st.size;
  }
  return total;
}
