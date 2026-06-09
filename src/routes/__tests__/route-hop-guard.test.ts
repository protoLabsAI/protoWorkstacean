import { describe, test, expect } from "bun:test";
import { RouteHopGuard } from "../route-hop-guard.ts";

describe("RouteHopGuard", () => {
  test("allows up to max hops per correlation, then drops", () => {
    const g = new RouteHopGuard({ max: 3, windowMs: 1000 });
    expect(g.allow("c1", 0)).toBe(true);  // 1
    expect(g.allow("c1", 1)).toBe(true);  // 2
    expect(g.allow("c1", 2)).toBe(true);  // 3
    expect(g.allow("c1", 3)).toBe(false); // capped
    expect(g.allow("c1", 4)).toBe(false); // stays capped within the window
  });

  test("a chain that goes quiet past the window resets", () => {
    const g = new RouteHopGuard({ max: 2, windowMs: 100 });
    expect(g.allow("c1", 0)).toBe(true);
    expect(g.allow("c1", 10)).toBe(true);
    expect(g.allow("c1", 20)).toBe(false);   // capped
    expect(g.allow("c1", 200)).toBe(true);   // window elapsed (expiresAt was 120) → reset
  });

  test("distinct correlations are tracked independently", () => {
    const g = new RouteHopGuard({ max: 1, windowMs: 1000 });
    expect(g.allow("a", 0)).toBe(true);
    expect(g.allow("b", 0)).toBe(true);   // different chain, not affected by a
    expect(g.allow("a", 1)).toBe(false);  // a is capped
    expect(g.allow("b", 1)).toBe(false);  // b is capped
  });

  test("expired entries are swept once the soft cap is reached (bounded memory)", () => {
    const g = new RouteHopGuard({ max: 5, windowMs: 100, pruneAt: 3 });
    g.allow("a", 0);
    g.allow("b", 0);
    g.allow("c", 0);           // size now 3 (== pruneAt)
    // Next call sees size >= pruneAt, sweeps the now-expired a/b/c, then adds d.
    g.allow("d", 500);
    expect(g.size).toBe(1);    // only "d" survives
  });
});
