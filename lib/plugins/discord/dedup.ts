/**
 * dedup.ts — short-TTL de-duplication for inbound Discord events.
 *
 * discord.js auto-reconnects and, on a gateway RESUME, replays events the
 * client missed while disconnected. Without dedup that re-delivers a
 * MessageCreate (or reaction) we already handled, so Ava responds twice. This
 * keeps a small TTL map of handled event keys and reports repeats.
 *
 * Module-level (one shared listener set across the process); opportunistically
 * pruned so it can't grow unbounded.
 */

const TTL_MS = 60_000;
const MAX_ENTRIES = 2000;
const seen = new Map<string, number>();

/**
 * Returns true if `key` was already handled within the TTL window (caller
 * should skip it). Otherwise records it and returns false.
 */
export function alreadyHandled(key: string): boolean {
  const now = Date.now();
  if (seen.size > MAX_ENTRIES) {
    for (const [k, t] of seen) if (now - t > TTL_MS) seen.delete(k);
  }
  const prev = seen.get(key);
  if (prev !== undefined && now - prev < TTL_MS) return true;
  seen.set(key, now);
  return false;
}

/** Test helper — clear all recorded keys. */
export function _resetDedup(): void {
  seen.clear();
}
