/**
 * CheckoutCache — content-addressed source-tree cache for clawpatch.
 *
 * Backs `src/api/clawpatch.ts` so structural review works against every
 * repo in the project registry — including the ones that used to be
 * bind-mounted into the container. Source of truth is GitHub's tarball
 * endpoint (`GET /repos/{owner}/{repo}/tarball/{ref}`); a successful fetch
 * lands at `${CHECKOUT_ROOT}/<owner>-<repo>/<sha>/`.
 *
 * Design notes live in docs/explanation/clawpatch-checkouts.md (C1) — the
 * short version:
 *
 *   - LRU eviction at 5 GB OR 50 entries, whichever first.
 *   - 1h TTL refresh: per the C1 sign-off — "better way over fast way" —
 *     over the 24h heuristic the doc originally biased toward.
 *   - Per-(repo, sha) extraction mutex: simultaneous reviews on the same PR
 *     head queue rather than racing.
 *   - Security: project-registry allowlist (enforced by the caller) plus
 *     tarball entry filter — reject `..`, absolute paths, and symlinks.
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
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_CHECKOUT_ROOT =
  process.env["CLAWPATCH_CHECKOUT_ROOT"] ??
  join(process.env["DATA_DIR"] ?? "/data", "checkouts");

const DEFAULT_SIZE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const DEFAULT_ENTRY_LIMIT = 50;
// 1h TTL. SHA-keyed content-addressing makes correctness fine at any TTL;
// this picks "fresh" over "warm-cache hit-rate". An hour amortizes the
// review-comment burst case (same PR head re-reviewed several times in
// quick succession) without holding stale source long enough to risk
// base-branch drift hiding review-relevant changes. Per C1 sign-off (#578).
const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_COMPRESSED_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB

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
   * Override the actual tarball fetch — tests inject a stub that copies a
   * fixture rather than hitting codeload.github.com.
   */
  fetchTarball?: (
    owner: string,
    repo: string,
    sha: string,
    token: string,
  ) => Promise<Buffer>;
}

interface ResolvedConfig {
  root: string;
  sizeLimitBytes: number;
  entryLimit: number;
  ttlMs: number;
  getToken: (owner: string, repo: string) => Promise<string>;
  fetchTarball: (
    owner: string,
    repo: string,
    sha: string,
    token: string,
  ) => Promise<Buffer>;
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
      fetchTarball: config.fetchTarball ?? defaultFetchTarball,
    };
  }

  /**
   * Resolve a local extracted-tree path for (repo, sha). Returns cache hit
   * if present and fresh; otherwise fetches + extracts. Throws on any
   * security / IO failure — never returns null.
   *
   * `repo` is "owner/name". Caller is responsible for enforcing the
   * project-registry allowlist before calling — this layer trusts its input.
   */
  async resolve(repo: string, sha: string): Promise<string> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
      throw new Error(`CheckoutCache: invalid repo shape '${repo}', expected owner/name`);
    }
    if (!/^[a-f0-9]{7,40}$/i.test(sha)) {
      throw new Error(`CheckoutCache: invalid sha '${sha}', expected hex ref`);
    }
    const key = `${repo}@${sha}`;
    const existingExtract = this.inflight.get(key);
    if (existingExtract) return existingExtract;

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
        console.log(
          `[checkout-cache] hit ${repo}@${sha.slice(0, 7)} (age ${(age / 60_000).toFixed(1)}m)`,
        );
        return dir;
      }
      console.log(
        `[checkout-cache] stale ${repo}@${sha.slice(0, 7)} (age ${(age / 60_000).toFixed(1)}m > ttl) — re-fetching`,
      );
      rmSync(dir, { recursive: true, force: true });
    }

    const [owner, name] = repo.split("/");
    const token = await this.cfg.getToken(owner, name);
    const tarball = await this.cfg.fetchTarball(owner, name, sha, token);
    if (tarball.byteLength > MAX_COMPRESSED_BYTES) {
      throw new Error(
        `CheckoutCache: tarball for ${repo}@${sha} is ${tarball.byteLength} bytes ` +
          `(> ${MAX_COMPRESSED_BYTES} cap) — refusing to extract`,
      );
    }
    await this._extract(tarball, dir, repo, sha);
    console.log(
      `[checkout-cache] miss ${repo}@${sha.slice(0, 7)} extracted (${tarball.byteLength} bytes)`,
    );
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
      console.log(
        `[checkout-cache] pruned ${evicted} entr${evicted === 1 ? "y" : "ies"} (${bytesFreed} bytes)`,
      );
    }
    return { evicted, bytesFreed };
  }

  private _dirFor(repo: string, sha: string): string {
    const slug = repo.replace("/", "-");
    return join(this.cfg.root, slug, sha);
  }

  private async _extract(
    tarball: Buffer,
    targetDir: string,
    repo: string,
    sha: string,
  ): Promise<void> {
    mkdirSync(targetDir, { recursive: true });
    const stagingParent = await mkdtemp(join(tmpdir(), "checkout-cache-"));
    const tarballPath = join(stagingParent, "src.tar.gz");
    writeFileSync(tarballPath, tarball);

    try {
      // Inspect entries before extracting — reject anything that would
      // escape the target dir (absolute path, .. traversal) or land on
      // host disk via a symlink/hardlink. GitHub's archives are not
      // adversarial, but the cache is fed by `repo` strings from agent
      // tool calls, so the filter pays for itself.
      const listing = await runTar(["-tzf", tarballPath]);
      const lines = listing.split("\n").filter(Boolean);
      for (const line of lines) {
        if (line.startsWith("/")) {
          throw new Error(`CheckoutCache: tarball for ${repo}@${sha} contains absolute path: ${line}`);
        }
        if (line.split("/").some(seg => seg === "..")) {
          throw new Error(`CheckoutCache: tarball for ${repo}@${sha} contains '..' segment: ${line}`);
        }
      }

      // `-h` would dereference symlinks (turning them into the file they point at);
      // we want to refuse them outright instead, so list with `tar -tvzf` and bail
      // if any entry's permission string starts with 'l' (symlink) or 'h' (hardlink).
      const verbose = await runTar(["-tvzf", tarballPath]);
      for (const line of verbose.split("\n")) {
        if (!line) continue;
        const perm = line[0];
        if (perm === "l" || perm === "h") {
          throw new Error(`CheckoutCache: tarball for ${repo}@${sha} contains symlink/hardlink: ${line}`);
        }
      }

      // GitHub tarballs nest everything under `<repo>-<sha>/` — strip that
      // top-level dir so the extracted tree is rooted at targetDir.
      await runTar(["-xzf", tarballPath, "-C", targetDir, "--strip-components=1"]);
    } catch (err) {
      // Don't leave a half-extracted tree around — the next resolve() would
      // mistake it for a cache hit.
      rmSync(targetDir, { recursive: true, force: true });
      throw err;
    } finally {
      await rm(stagingParent, { recursive: true, force: true });
    }
  }
}

function defaultFetchTarball(
  owner: string,
  repo: string,
  sha: string,
  token: string,
): Promise<Buffer> {
  const url = `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`;
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "protoWorkstacean-checkout-cache",
      Accept: "application/vnd.github+json",
    },
    redirect: "follow",
  }).then(async res => {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `CheckoutCache: GitHub tarball ${owner}/${repo}@${sha} returned ${res.status} ${res.statusText} — ${body.slice(0, 200)}`,
      );
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  });
}

function runTar(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", chunk => { stdout += String(chunk); });
    proc.stderr.on("data", chunk => { stderr += String(chunk); });
    proc.on("error", reject);
    proc.on("close", code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`tar ${args.join(" ")} exited ${code}: ${stderr.trim()}`));
    });
  });
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
