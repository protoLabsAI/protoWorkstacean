/**
 * KnowledgeStore — searchable long-term memory (bun:sqlite + FTS5).
 *
 * Ports protoAgent's KnowledgeStore: a chunk table mirrored into an FTS5 index
 * (BM25-ranked) so agents can recall relevant facts from prior conversations.
 * Chunks carry a `domain` so different sources stay distinguishable:
 *   - "conversation" — summaries of retired conversations (harvester, Phase 3)
 *   - "finding"      — substantive answers extracted per turn (Phase 2)
 *   - "hot"          — always-on facts injected into every recall
 *
 * FTS5 (lexical, BM25) is the always-on floor — no embedding service in the hot
 * path, so recall can't be taken down by an embeddings outage. A semantic layer
 * can be layered on later by fusing vector hits, but lexical recall ships first
 * (this is exactly what protoAgent runs by default).
 *
 * Shares `data/knowledge.db`. Degrades to a no-op when the DB is unavailable.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface KnowledgeChunk {
  id: number;
  content: string;
  domain: string;
  heading: string | null;
  source: string | null;
  createdAt: number;
}

export interface KnowledgeHit {
  id: number;
  content: string;
  domain: string;
  heading: string | null;
  /** First ~200 chars — what recall injects. */
  preview: string;
}

const PREVIEW_CHARS = 240;

export class KnowledgeStore {
  private db: Database | null = null;
  private ftsAvailable = false;
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
      this.db.exec("PRAGMA busy_timeout=5000;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS chunks (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          content     TEXT    NOT NULL,
          domain      TEXT    NOT NULL DEFAULT 'general',
          heading     TEXT,
          source      TEXT,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_domain ON chunks(domain);
      `);

      // FTS5 mirror + sync triggers. Wrapped: a SQLite build without FTS5
      // falls back to a LIKE scan (still functional, just slower).
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
            content, heading, content='chunks', content_rowid='id'
          );
          CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
            INSERT INTO chunks_fts(rowid, content, heading) VALUES (new.id, new.content, new.heading);
          END;
          CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content, heading) VALUES ('delete', old.id, old.content, old.heading);
          END;
          CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
            INSERT INTO chunks_fts(chunks_fts, rowid, content, heading) VALUES ('delete', old.id, old.content, old.heading);
            INSERT INTO chunks_fts(rowid, content, heading) VALUES (new.id, new.content, new.heading);
          END;
        `);
        this.ftsAvailable = true;
      } catch (err) {
        console.warn(`[knowledge-store] FTS5 unavailable — using LIKE fallback: ${err instanceof Error ? err.message : String(err)}`);
        this.ftsAvailable = false;
      }
      console.log(`[knowledge-store] DB ready: ${this.dbPath} (fts5=${this.ftsAvailable})`);
    } catch (err) {
      console.error(`[knowledge-store] DB init failed: ${err instanceof Error ? err.message : String(err)}`);
      this.db = null;
    }
  }

  /** Insert a chunk. Returns the new row id, or null on failure (never throws). */
  addChunk(content: string, opts: { domain?: string; heading?: string; source?: string } = {}): number | null {
    if (!this.db || !content.trim()) return null;
    try {
      const res = this.db
        .query(`INSERT INTO chunks (content, domain, heading, source, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(content, opts.domain ?? "general", opts.heading ?? null, opts.source ?? null, Date.now());
      return Number(res.lastInsertRowid);
    } catch (err) {
      console.warn(`[knowledge-store] addChunk failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** BM25-ranked (or LIKE-fallback) search. Optionally scoped to a domain. */
  search(query: string, k = 5, domain?: string): KnowledgeHit[] {
    if (!this.db) return [];
    const tokens = (query.match(/[\w']+/g) ?? []).filter((t) => t.length > 1);
    if (tokens.length === 0) return [];
    try {
      if (this.ftsAvailable) {
        const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
        const sql = domain
          ? `SELECT c.id, c.content, c.domain, c.heading FROM chunks_fts f
             JOIN chunks c ON c.id = f.rowid
             WHERE chunks_fts MATCH ? AND c.domain = ? ORDER BY rank LIMIT ?`
          : `SELECT c.id, c.content, c.domain, c.heading FROM chunks_fts f
             JOIN chunks c ON c.id = f.rowid
             WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`;
        const rows = domain
          ? this.db.query<{ id: number; content: string; domain: string; heading: string | null }, [string, string, number]>(sql).all(match, domain, k)
          : this.db.query<{ id: number; content: string; domain: string; heading: string | null }, [string, number]>(sql).all(match, k);
        return rows.map((r) => this._toHit(r));
      }
      return this._likeSearch(tokens, k, domain);
    } catch (err) {
      console.warn(`[knowledge-store] search failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  private _likeSearch(tokens: string[], k: number, domain?: string): KnowledgeHit[] {
    if (!this.db) return [];
    const esc = (t: string) => `%${t.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
    const scoreExpr = tokens.map(() => `(CASE WHEN content LIKE ? ESCAPE '\\' OR heading LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END)`).join(" + ");
    const params: (string | number)[] = [];
    for (const t of tokens) { params.push(esc(t), esc(t)); }
    let sql = `SELECT id, content, domain, heading, (${scoreExpr}) AS score FROM chunks`;
    if (domain) { sql += ` WHERE domain = ?`; params.push(domain); }
    sql += ` ORDER BY score DESC, id DESC LIMIT ?`;
    params.push(k);
    const rows = this.db.query<{ id: number; content: string; domain: string; heading: string | null; score: number }, (string | number)[]>(sql).all(...params);
    return rows.filter((r) => r.score > 0).map((r) => this._toHit(r));
  }

  /** All `domain="hot"` chunks concatenated, newest-first, trimmed to `maxChars`. */
  getHotMemory(maxChars = 4000): string {
    if (!this.db) return "";
    try {
      const rows = this.db
        .query<{ content: string }, []>(`SELECT content FROM chunks WHERE domain = 'hot' ORDER BY id DESC`)
        .all();
      let out = "";
      for (const r of rows) {
        if (out.length + r.content.length + 1 > maxChars) break;
        out += (out ? "\n" : "") + r.content;
      }
      return out;
    } catch {
      return "";
    }
  }

  private _toHit(r: { id: number; content: string; domain: string; heading: string | null }): KnowledgeHit {
    const preview = r.content.length > PREVIEW_CHARS ? r.content.slice(0, PREVIEW_CHARS) + "…" : r.content;
    return { id: r.id, content: r.content, domain: r.domain, heading: r.heading, preview };
  }

  close(): void {
    if (this.db) { this.db.close(); this.db = null; }
  }
}
