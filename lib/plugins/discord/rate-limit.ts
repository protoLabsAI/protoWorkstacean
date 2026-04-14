/**
 * rate-limit.ts — In-memory + SQLite rate limiter and spam pattern checker.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { DiscordContext } from "./core.ts";

// ── Spam pattern compilation ──────────────────────────────────────────────────

export function compileSpamPatterns(patterns: string[]): RegExp[] {
  return patterns.flatMap(p => {
    try {
      if (/(\([^)]*[+*][^)]*\))[+*?]/.test(p)) {
        console.warn(`[discord] Skipping potentially unsafe spam pattern (nested quantifiers): "${p}"`);
        return [];
      }
      return [new RegExp(p, "i")];
    } catch (err) {
      console.warn(`[discord] Skipping invalid spam pattern "${p}":`, err);
      return [];
    }
  });
}

// ── SQLite persistence ────────────────────────────────────────────────────────

export function openRateLimitDb(ctx: DiscordContext, dataDir: string): void {
  try {
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    ctx.rlDb = new Database(join(dataDir, "events.db"));
    ctx.rlDb.exec("PRAGMA journal_mode=WAL");
    ctx.rlDb.exec(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        user_id TEXT NOT NULL,
        ts INTEGER NOT NULL
      )
    `);
    ctx.rlDb.exec("CREATE INDEX IF NOT EXISTS idx_rate_limits_user_ts ON rate_limits(user_id, ts)");

    const cutoff = Date.now() - ctx.rateWindowMs;
    const rows = ctx.rlDb
      .query("SELECT user_id, ts FROM rate_limits WHERE ts > ?")
      .all(cutoff) as { user_id: string; ts: number }[];

    for (const row of rows) {
      const hits = ctx.rateLimits.get(row.user_id) ?? [];
      hits.push(row.ts);
      ctx.rateLimits.set(row.user_id, hits);
    }

    console.log(`[discord] Rate-limit DB opened (${rows.length} persisted hit(s) loaded)`);
  } catch (err) {
    console.warn("[discord] Could not open rate-limit DB — falling back to in-memory only:", err);
    ctx.rlDb = null;
  }
}

// ── Rate limit check ──────────────────────────────────────────────────────────

export function isRateLimited(ctx: DiscordContext, userId: string): boolean {
  const now = Date.now();
  const hits = (ctx.rateLimits.get(userId) ?? []).filter(t => now - t < ctx.rateWindowMs);
  hits.push(now);
  ctx.rateLimits.set(userId, hits);

  if (ctx.rlDb) {
    try {
      ctx.rlDb.run("INSERT INTO rate_limits (user_id, ts) VALUES (?, ?)", [userId, now]);
      ctx.rlDb.run("DELETE FROM rate_limits WHERE user_id = ? AND ts <= ?", [userId, now - ctx.rateWindowMs]);
    } catch (err) {
      console.warn("[discord] Failed to persist rate-limit hit:", err);
    }
  }

  return hits.length > ctx.rateMaxMessages;
}

// ── Spam check ────────────────────────────────────────────────────────────────

export function isSpam(ctx: DiscordContext, content: string): boolean {
  return ctx.spamPatterns.some(p => p.test(content));
}
