/**
 * RouteHopGuard — bounds route cascades (ADR-0008 P2 hardening).
 *
 * A route always emits `agent.skill.request`, never an arbitrary topic, so it
 * cannot *directly* re-trigger its own `when.topic` (the loader also rejects
 * `#`/`agent.skill.request` triggers). But a route's dispatch can *indirectly*
 * cause its trigger to fire again — agent → side-effect topic → another route →
 * … — an unbounded cross-route cycle. The dispatcher's cooldown is per-`(skill,
 * target)` rate-limiting, not a cycle breaker; `activeExecutions` is
 * correlation-keyed, not a hop counter. So routing needs its own bound.
 *
 * Routes that share a cause share a `correlationId` (each route reuses its
 * trigger's). This guard caps the number of route dispatches permitted per
 * correlation chain inside a time window — breaking the cascade while leaving
 * normal fan-out (one cause → a few routes) untouched. Pure + clock-injected so
 * it's deterministically testable.
 */

export interface RouteHopGuardOptions {
  /** Max route dispatches allowed per correlation chain within the window. */
  max?: number;
  /** Sliding window (ms): a correlation that goes quiet this long resets. */
  windowMs?: number;
  /** Soft cap on tracked correlations before an expired-entry sweep runs. */
  pruneAt?: number;
}

export class RouteHopGuard {
  private readonly max: number;
  private readonly windowMs: number;
  private readonly pruneAt: number;
  private readonly seen = new Map<string, { count: number; expiresAt: number }>();

  constructor(opts: RouteHopGuardOptions = {}) {
    this.max = opts.max ?? 12;
    this.windowMs = opts.windowMs ?? 30_000;
    this.pruneAt = opts.pruneAt ?? 1000;
  }

  /**
   * Record a route hop for `correlationId` and report whether it is allowed.
   * Returns false once the chain has hit `max` within the window — the caller
   * drops the dispatch. An expired (quiet > windowMs) chain resets to 1.
   */
  allow(correlationId: string, now: number): boolean {
    if (this.seen.size >= this.pruneAt) this._prune(now);
    const e = this.seen.get(correlationId);
    if (!e || e.expiresAt <= now) {
      this.seen.set(correlationId, { count: 1, expiresAt: now + this.windowMs });
      return true;
    }
    if (e.count >= this.max) return false; // capped — do NOT extend the window (let it drain)
    e.count += 1;
    e.expiresAt = now + this.windowMs;
    return true;
  }

  /** Tracked-correlation count (for tests / diagnostics). */
  get size(): number {
    return this.seen.size;
  }

  private _prune(now: number): void {
    for (const [k, v] of this.seen) if (v.expiresAt <= now) this.seen.delete(k);
  }
}
