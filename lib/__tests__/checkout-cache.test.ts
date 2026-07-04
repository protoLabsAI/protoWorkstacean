/**
 * CheckoutCache unit tests — exercise the clone path, the LRU pruner, the
 * TTL refresh path, and the concurrency mutex. `cloneRepo` is stubbed to
 * populate the target dir from an in-memory fixture, so the tests never
 * touch github.com or shell out to git.
 */

import { describe, test, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
 * Build a `cloneRepo` stub that materializes `files` into the target dir,
 * mimicking a real git checkout. Increments `counter.n` per invocation so
 * tests can assert cache hits vs misses.
 */
function fakeClone(
  files: Record<string, string>,
  counter?: { n: number },
  opts?: { delayMs?: number },
) {
  return async (
    _owner: string,
    _repo: string,
    _headSha: string,
    _token: string,
    targetDir: string,
  ): Promise<void> => {
    if (counter) counter.n++;
    if (opts?.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    for (const [path, content] of Object.entries(files)) {
      const full = join(targetDir, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
  };
}

function makeCache(opts?: ConstructorParameters<typeof CheckoutCache>[0]) {
  const root = mkdtempSync(join(tmpdir(), "checkout-cache-test-"));
  const cache = new CheckoutCache({
    root,
    getToken: async () => "fake-token",
    cloneRepo: fakeClone({ "a.txt": "1" }), // overridden per-test
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
    test("first call clones + checks out, second call hits cache", async () => {
      const counter = { n: 0 };
      const { cache, root, cleanup } = makeCache({
        cloneRepo: fakeClone(
          { "README.md": "# widgets", "src/index.ts": "export const x = 1;" },
          counter,
        ),
      });
      try {
        const path1 = await cache.resolve("acme/widgets", SHA_A);
        expect(path1).toBe(join(root, "acme-widgets", SHA_A));
        expect(existsSync(join(path1, "README.md"))).toBe(true);
        expect(existsSync(join(path1, "src", "index.ts"))).toBe(true);
        expect(counter.n).toBe(1);

        const path2 = await cache.resolve("acme/widgets", SHA_A);
        expect(path2).toBe(path1);
        expect(counter.n).toBe(1); // cache hit
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

    test("a failed clone leaves no half-written entry behind", async () => {
      const { cache, root, cleanup } = makeCache({
        cloneRepo: async (_o, _r, _s, _t, targetDir) => {
          // Write a partial tree, then fail — resolve() must clean it up.
          mkdirSync(targetDir, { recursive: true });
          writeFileSync(join(targetDir, "partial.txt"), "half");
          throw new Error("git exploded");
        },
      });
      try {
        await expect(cache.resolve("acme/widgets", SHA_A)).rejects.toThrow(/git exploded/);
        expect(existsSync(join(root, "acme-widgets", SHA_A))).toBe(false);
      } finally { cleanup(); }
    });

    test("stale entry past TTL is re-cloned", async () => {
      const counter = { n: 0 };
      const { cache, root, cleanup } = makeCache({
        ttlMs: 1000, // 1s for test
        cloneRepo: fakeClone({ "a.txt": "1" }, counter),
      });
      try {
        await cache.resolve("acme/widgets", SHA_A);
        // Backdate the entry's mtime past the TTL.
        const dir = join(root, "acme-widgets", SHA_A);
        const old = new Date(Date.now() - 5_000);
        utimesSync(dir, old, old);

        await cache.resolve("acme/widgets", SHA_A);
        expect(counter.n).toBe(2);
      } finally { cleanup(); }
    });

    test("concurrent calls for same (repo, sha) share one clone", async () => {
      const counter = { n: 0 };
      const { cache, cleanup } = makeCache({
        cloneRepo: fakeClone({ "a.txt": "1" }, counter, { delayMs: 50 }),
      });
      try {
        const [p1, p2, p3] = await Promise.all([
          cache.resolve("acme/widgets", SHA_A),
          cache.resolve("acme/widgets", SHA_A),
          cache.resolve("acme/widgets", SHA_A),
        ]);
        expect(p1).toBe(p2);
        expect(p2).toBe(p3);
        expect(counter.n).toBe(1);
      } finally { cleanup(); }
    });
  });

  describe("prune()", () => {
    test("evicts LRU entries when over entry cap", async () => {
      const { cache, root, cleanup } = makeCache({
        entryLimit: 2,
        // 10 GB headroom so size cap never trips.
        sizeLimitBytes: 10 * 1024 * 1024 * 1024,
        cloneRepo: fakeClone({ "a.txt": "x" }),
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
        cloneRepo: fakeClone({ "a.txt": "1" }),
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
