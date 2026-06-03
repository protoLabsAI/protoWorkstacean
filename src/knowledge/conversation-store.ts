/**
 * ConversationStore — durable per-conversation turn history (bun:sqlite).
 *
 * The in-process DeepAgent runtime invokes the LangGraph ReAct loop with a
 * single user message and no checkpointer, so without this an agent has zero
 * memory of prior turns — every message is handled in isolation. This store
 * persists each (contextId, role, content) turn and lets the executor replay
 * the recent tail into the next invocation's message list.
 *
 * It also tracks per-conversation last-activity in `conversation_meta`, which
 * the harvester (Phase 3) uses to retire aged-out conversations into the
 * searchable KnowledgeStore.
 *
 * Shares `data/knowledge.db` with the rest of the knowledge layer. Gracefully
 * degrades to a no-op when the DB is unavailable — memory is best-effort and
 * must never break a running skill.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type TurnRole = "user" | "assistant";

export interface ConversationTurn {
  role: TurnRole;
  content: string;
}

export interface RetirableConversation {
  contextId: string;
  agent: string | null;
  lastActivity: number;
}

/** Hard cap on stored turns per conversation — prevents unbounded growth. */
const MAX_TURNS_PER_CONVERSATION = 200;

export class ConversationStore {
  private db: Database | null = null;
  private readonly dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = resolve(dbPath ?? "data/knowledge.db");
  }

  init(): void {
    try {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      this.db = new Database(this.dbPath);
      this.db.exec("PRAGMA journal_mode=WAL;");
      this.db.exec("PRAGMA synchronous=NORMAL;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS conversation_turns (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          context_id  TEXT    NOT NULL,
          role        TEXT    NOT NULL,
          content     TEXT    NOT NULL,
          agent       TEXT,
          skill       TEXT,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_conversation_turns_context
          ON conversation_turns(context_id, id);

        CREATE TABLE IF NOT EXISTS conversation_meta (
          context_id    TEXT PRIMARY KEY,
          agent         TEXT,
          created_at    INTEGER NOT NULL,
          last_activity INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_conversation_meta_activity
          ON conversation_meta(last_activity);
      `);
      console.log(`[conversation-store] DB ready: ${this.dbPath}`);
    } catch (err) {
      console.error(`[conversation-store] DB init failed: ${err instanceof Error ? err.message : String(err)}`);
      this.db = null;
    }
  }

  /** Append one turn and bump the conversation's last-activity. Best-effort. */
  appendTurn(contextId: string, role: TurnRole, content: string, agent?: string, skill?: string): void {
    if (!this.db || !content.trim()) return;
    const now = Date.now();
    try {
      const tx = this.db.transaction(() => {
        this.db!
          .query(`INSERT INTO conversation_turns (context_id, role, content, agent, skill, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)`)
          .run(contextId, role, content, agent ?? null, skill ?? null, now);
        // Upsert meta (created_at preserved on conflict, last_activity bumped).
        this.db!
          .query(`INSERT INTO conversation_meta (context_id, agent, created_at, last_activity)
                  VALUES (?, ?, ?, ?)
                  ON CONFLICT(context_id) DO UPDATE SET last_activity = excluded.last_activity,
                    agent = COALESCE(conversation_meta.agent, excluded.agent)`)
          .run(contextId, agent ?? null, now, now);
        // Prune oldest turns beyond the cap for this conversation.
        this.db!
          .query(`DELETE FROM conversation_turns
                  WHERE context_id = ? AND id NOT IN (
                    SELECT id FROM conversation_turns WHERE context_id = ? ORDER BY id DESC LIMIT ?
                  )`)
          .run(contextId, contextId, MAX_TURNS_PER_CONVERSATION);
      });
      tx();
    } catch (err) {
      console.warn(`[conversation-store] appendTurn failed for ${contextId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Most recent `limit` turns for a conversation, oldest-first (chronological). */
  recentTurns(contextId: string, limit = 10): ConversationTurn[] {
    if (!this.db) return [];
    try {
      const rows = this.db
        .query<{ role: string; content: string }, [string, number]>(
          `SELECT role, content FROM conversation_turns
           WHERE context_id = ? ORDER BY id DESC LIMIT ?`,
        )
        .all(contextId, limit);
      return rows
        .reverse()
        .map((r) => ({ role: r.role === "assistant" ? "assistant" : "user", content: r.content }));
    } catch (err) {
      console.warn(`[conversation-store] recentTurns failed for ${contextId}: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /** All turns for a conversation, oldest-first — used by the harvester. */
  allTurns(contextId: string): ConversationTurn[] {
    if (!this.db) return [];
    try {
      const rows = this.db
        .query<{ role: string; content: string }, [string]>(
          `SELECT role, content FROM conversation_turns WHERE context_id = ? ORDER BY id ASC`,
        )
        .all(contextId);
      return rows.map((r) => ({ role: r.role === "assistant" ? "assistant" : "user", content: r.content }));
    } catch {
      return [];
    }
  }

  /** Conversations whose last activity is older than `maxAgeMs` — harvest candidates. */
  retirable(maxAgeMs: number, now = Date.now(), limit = 50): RetirableConversation[] {
    if (!this.db) return [];
    try {
      const cutoff = now - maxAgeMs;
      const rows = this.db
        .query<{ context_id: string; agent: string | null; last_activity: number }, [number, number]>(
          `SELECT context_id, agent, last_activity FROM conversation_meta
           WHERE last_activity < ? ORDER BY last_activity ASC LIMIT ?`,
        )
        .all(cutoff, limit);
      return rows.map((r) => ({ contextId: r.context_id, agent: r.agent, lastActivity: r.last_activity }));
    } catch {
      return [];
    }
  }

  /** Drop a conversation's turns + meta (after harvest). */
  deleteConversation(contextId: string): void {
    if (!this.db) return;
    try {
      const tx = this.db.transaction(() => {
        this.db!.query(`DELETE FROM conversation_turns WHERE context_id = ?`).run(contextId);
        this.db!.query(`DELETE FROM conversation_meta WHERE context_id = ?`).run(contextId);
      });
      tx();
    } catch (err) {
      console.warn(`[conversation-store] deleteConversation failed for ${contextId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  close(): void {
    if (this.db) { this.db.close(); this.db = null; }
  }
}
