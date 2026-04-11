/**
 * discord/rate-limit.ts — in-memory + SQLite rate limiter and spam detection.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

export interface RateLimiter {
  isRateLimited(userId: string): boolean;
  isSpam(content: string): boolean;
  reconfigure(maxMessages: number, windowMs: number, spamPatterns: RegExp[]): void;
  close(): void;
}

export function createRateLimiter(opts: {
  dataDir: string | null;
  maxMessages: number;
  windowMs: number;
  spamPatterns: RegExp[];
}): RateLimiter {
  let { maxMessages, windowMs, spamPatterns } = opts;
  const rateLimits = new Map<string, number[]>();
  let rlDb: Database | null = null;

  if (opts.dataDir) {
    try {
      if (!existsSync(opts.dataDir)) {
        mkdirSync(opts.dataDir, { recursive: true });
      }

      rlDb = new Database(join(opts.dataDir, "events.db"));
      rlDb.exec("PRAGMA journal_mode=WAL");
      rlDb.exec(`
        CREATE TABLE IF NOT EXISTS rate_limits (
          user_id TEXT NOT NULL,
          ts INTEGER NOT NULL
        )
      `);
      rlDb.exec("CREATE INDEX IF NOT EXISTS idx_rate_limits_user_ts ON rate_limits(user_id, ts)");

      // Load persisted windows into memory
      const cutoff = Date.now() - windowMs;
      const rows = rlDb
        .query("SELECT user_id, ts FROM rate_limits WHERE ts > ?")
        .all(cutoff) as { user_id: string; ts: number }[];

      for (const row of rows) {
        const hits = rateLimits.get(row.user_id) ?? [];
        hits.push(row.ts);
        rateLimits.set(row.user_id, hits);
      }

      console.log(`[discord] Rate-limit DB opened (${rows.length} persisted hit(s) loaded)`);
    } catch (err) {
      console.warn("[discord] Could not open rate-limit DB — falling back to in-memory only:", err);
      rlDb = null;
    }
  }

  return {
    isRateLimited(userId: string): boolean {
      const now = Date.now();
      const hits = (rateLimits.get(userId) ?? []).filter(t => now - t < windowMs);
      hits.push(now);
      rateLimits.set(userId, hits);

      if (rlDb) {
        try {
          rlDb.run("INSERT INTO rate_limits (user_id, ts) VALUES (?, ?)", [userId, now]);
          // Prune expired rows for this user to keep the table tidy
          rlDb.run("DELETE FROM rate_limits WHERE user_id = ? AND ts <= ?", [userId, now - windowMs]);
        } catch (err) {
          console.warn("[discord] Failed to persist rate-limit hit:", err);
        }
      }

      return hits.length > maxMessages;
    },

    isSpam(content: string): boolean {
      return spamPatterns.some(p => p.test(content));
    },

    reconfigure(newMax: number, newWindow: number, newPatterns: RegExp[]): void {
      maxMessages = newMax;
      windowMs = newWindow;
      spamPatterns = newPatterns;
    },

    close(): void {
      if (rlDb) {
        rlDb.close();
        rlDb = null;
      }
    },
  };
}
