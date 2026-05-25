/**
 * CheckoutCache unit tests — exercise extraction, the LRU pruner, the TTL
 * refresh path, the concurrency mutex, and tarball-entry security guards
 * against an in-memory tar fixture. Hits real `tar` on disk (the lib shells
 * out to it) but never touches GitHub — `fetchTarball` is stubbed.
 */

import { describe, test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckoutCache } from "../checkout-cache.ts";

const SHA_A = "1234567890abcdef1234567890abcdef12345678";
const SHA_B = "abcdef0123456789abcdef0123456789abcdef01";

/**
 * Build a minimal GitHub-shaped tarball in a temp dir and return its bytes.
 * Top-level directory is `${repo}-${sha}/` to match what `tar
 * --strip-components=1` expects.
 */
function makeTarball(
  repo: string,
  sha: string,
  files: Record<string, string>,
  opts?: { withSymlink?: boolean; withTraversal?: boolean },
): Buffer {
  const slug = repo.replace("/", "-");
  const stage = mkdtempSync(join(tmpdir(), "tarball-fixture-"));
  const root = join(stage, `${slug}-${sha}`);
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  if (opts?.withSymlink) {
    const linkSrc = join(root, "link.txt");
    spawnSync("ln", ["-s", "/etc/passwd", linkSrc]);
  }
  if (opts?.withTraversal) {
    // Hand-craft a tarball with a `../escaped.txt` entry. Easiest path:
    // build it via `tar` with --transform.
    writeFileSync(join(root, "evil.txt"), "should-not-extract");
  }
  const out = join(stage, "out.tgz");
  const tarArgs = ["-czf", out, "-C", stage, `${slug}-${sha}`];
  if (opts?.withTraversal) {
    tarArgs.push("--transform=s|evil.txt|../escaped.txt|");
  }
  const tar = spawnSync("tar", tarArgs);
  if (tar.status !== 0) {
    throw new Error(`fixture tar failed: ${tar.stderr.toString()}`);
  }
  const bytes = readFileSync(out);
  rmSync(stage, { recursive: true, force: true });
  return bytes;
}

function makeCache(opts?: ConstructorParameters<typeof CheckoutCache>[0]) {
  const root = mkdtempSync(join(tmpdir(), "checkout-cache-test-"));
  const cache = new CheckoutCache({
    root,
    getToken: async () => "fake-token",
    fetchTarball: async () => Buffer.alloc(0), // overridden per-test
    ...opts,
  });
  return {
    root,
    cache,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("CheckoutCache", () => {
  describe("resolve()", () => {
    test("first call fetches + extracts, second call hits cache", async () => {
      let fetches = 0;
      const tarball = makeTarball("acme/widgets", SHA_A, {
        "README.md": "# widgets",
        "src/index.ts": "export const x = 1;",
      });
      const { cache, root, cleanup } = makeCache({
        fetchTarball: async () => { fetches++; return tarball; },
      });
      try {
        const path1 = await cache.resolve("acme/widgets", SHA_A);
        expect(path1).toBe(join(root, "acme-widgets", SHA_A));
        expect(existsSync(join(path1, "README.md"))).toBe(true);
        expect(existsSync(join(path1, "src", "index.ts"))).toBe(true);
        expect(fetches).toBe(1);

        const path2 = await cache.resolve("acme/widgets", SHA_A);
        expect(path2).toBe(path1);
        expect(fetches).toBe(1); // cache hit
      } finally {
        cleanup();
      }
    });

    test("rejects bad repo + bad sha shapes", async () => {
      const { cache, cleanup } = makeCache();
      try {
        await expect(cache.resolve("bare-name", SHA_A)).rejects.toThrow(/invalid repo/);
        await expect(cache.resolve("acme/widgets", "not-hex")).rejects.toThrow(/invalid sha/);
      } finally { cleanup(); }
    });

    test("stale entry past TTL is refetched", async () => {
      let fetches = 0;
      const tarball = makeTarball("acme/widgets", SHA_A, { "a.txt": "1" });
      const { cache, root, cleanup } = makeCache({
        ttlMs: 1000, // 1s for test
        fetchTarball: async () => { fetches++; return tarball; },
      });
      try {
        await cache.resolve("acme/widgets", SHA_A);
        // Backdate the entry's mtime past the TTL.
        const dir = join(root, "acme-widgets", SHA_A);
        const old = new Date(Date.now() - 5_000);
        utimesSync(dir, old, old);

        await cache.resolve("acme/widgets", SHA_A);
        expect(fetches).toBe(2);
      } finally { cleanup(); }
    });

    test("concurrent calls for same (repo, sha) share one extraction", async () => {
      let fetches = 0;
      const tarball = makeTarball("acme/widgets", SHA_A, { "a.txt": "1" });
      const { cache, cleanup } = makeCache({
        fetchTarball: async () => {
          fetches++;
          await new Promise(r => setTimeout(r, 50));
          return tarball;
        },
      });
      try {
        const [p1, p2, p3] = await Promise.all([
          cache.resolve("acme/widgets", SHA_A),
          cache.resolve("acme/widgets", SHA_A),
          cache.resolve("acme/widgets", SHA_A),
        ]);
        expect(p1).toBe(p2);
        expect(p2).toBe(p3);
        expect(fetches).toBe(1);
      } finally { cleanup(); }
    });
  });

  describe("security guards", () => {
    test("refuses tarballs containing symlinks", async () => {
      const tarball = makeTarball("acme/widgets", SHA_A, { "a.txt": "1" }, { withSymlink: true });
      const { cache, root, cleanup } = makeCache({ fetchTarball: async () => tarball });
      try {
        await expect(cache.resolve("acme/widgets", SHA_A)).rejects.toThrow(/symlink/);
        // half-extracted tree must be cleaned up
        expect(existsSync(join(root, "acme-widgets", SHA_A))).toBe(false);
      } finally { cleanup(); }
    });

    test("refuses tarballs with .. traversal", async () => {
      const tarball = makeTarball("acme/widgets", SHA_A, { "a.txt": "1" }, { withTraversal: true });
      const { cache, root, cleanup } = makeCache({ fetchTarball: async () => tarball });
      try {
        await expect(cache.resolve("acme/widgets", SHA_A)).rejects.toThrow(/\.\./);
        expect(existsSync(join(root, "acme-widgets", SHA_A))).toBe(false);
      } finally { cleanup(); }
    });
  });

  describe("prune()", () => {
    test("evicts LRU entries when over entry cap", async () => {
      const { cache, root, cleanup } = makeCache({
        entryLimit: 2,
        // 10 GB headroom so size cap never trips.
        sizeLimitBytes: 10 * 1024 * 1024 * 1024,
        fetchTarball: async (_o, _r, sha) =>
          makeTarball("acme/widgets", sha, { "a.txt": `${sha}` }),
      });
      try {
        await cache.resolve("acme/widgets", SHA_A);
        // Force ordering by backdating SHA_A so it's clearly the oldest.
        const aDir = join(root, "acme-widgets", SHA_A);
        const old = new Date(Date.now() - 60_000);
        utimesSync(aDir, old, old);

        await cache.resolve("acme/widgets", SHA_B);
        const cSha = "fedcba9876543210fedcba9876543210fedcba98";
        await cache.resolve("acme/widgets", cSha);

        const res = await cache.prune();
        expect(res.evicted).toBeGreaterThanOrEqual(1);
        expect(existsSync(aDir)).toBe(false);                              // LRU victim
        expect(existsSync(join(root, "acme-widgets", cSha))).toBe(true);    // freshest stays
      } finally { cleanup(); }
    });

    test("evicts entries past TTL outright (no LRU survivor)", async () => {
      const { cache, root, cleanup } = makeCache({
        ttlMs: 1000,
        fetchTarball: async (_o, _r, sha) =>
          makeTarball("acme/widgets", sha, { "a.txt": "1" }),
      });
      try {
        await cache.resolve("acme/widgets", SHA_A);
        const dir = join(root, "acme-widgets", SHA_A);
        const old = new Date(Date.now() - 5_000);
        utimesSync(dir, old, old);

        const res = await cache.prune();
        expect(res.evicted).toBe(1);
        expect(existsSync(dir)).toBe(false);
      } finally { cleanup(); }
    });

    test("no-op on missing root", async () => {
      const root = join(tmpdir(), `does-not-exist-${crypto.randomUUID()}`);
      const cache = new CheckoutCache({ root });
      const res = await cache.prune();
      expect(res.evicted).toBe(0);
      expect(res.bytesFreed).toBe(0);
    });
  });
});
