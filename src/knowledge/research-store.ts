/**
 * ResearchStore — the researcher agent's hybrid knowledge base (bun:sqlite).
 *
 * Ports protoResearcher's storage layer onto workstacean's rails: a unified
 * `research_chunks` table mirrored into both an FTS5 index (BM25, lexical) and
 * a sqlite-vec virtual table (cosine KNN, semantic). `hybridSearch` fuses the
 * two ranked lists with Reciprocal Rank Fusion — the combination that, per
 * protoResearcher, fixes the failure modes of either signal alone.
 *
 * Embeddings come from the gateway (qwen3-embedding via gateway-embed.ts). The vector half is
 * best-effort: if the embedding service is down (embed returns null) we simply
 * store the chunk without a vector and degrade to keyword-only search, never
 * blocking ingestion. Same file as the rest of the knowledge layer.
 *
 * Distinct from KnowledgeStore (Ava's conversation memory) — different domain
 * (papers/findings/digests/model releases), different agent (researcher).
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { gatewayEmbed as embed } from "../services/embeddings/gateway-embed.ts";
import { logger } from "../../lib/log.ts";

const log = logger("research-store");

/** What a chunk represents — drives filtering + how the agent reads it back. */
export type ResearchKind = "paper" | "finding" | "digest" | "model_release";

export interface ResearchChunkInput {
  kind: ResearchKind;
  content: string;
  title?: string;
  source?: string;
  sourceType?: string;
  url?: string;
  metadata?: Record<string, unknown>;
}

export interface ResearchHit {
  id: number;
  kind: ResearchKind;
  title: string | null;
  preview: string;
  source: string | null;
  url: string | null;
  /** RRF score (hybrid) or single-signal rank score. Higher = better. */
  score: number;
}

/** Gateway text-embedding-3-small is 1024-dim as served; override via env if RESEARCH_EMBED_MODEL changes. */
const EMBED_DIM = Number(process.env.RESEARCH_EMBED_DIM ?? 1024);
const RRF_K = 60;
const PREVIEW_CHARS = 280;

export class ResearchStore {
  private db: Database | null = null;
  private vecAvailable = false;
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
        CREATE TABLE IF NOT EXISTS research_chunks (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          kind        TEXT    NOT NULL,
          title       TEXT,
          content     TEXT    NOT NULL,
          source      TEXT,
          source_type TEXT,
          url         TEXT,
          metadata    TEXT,
          created_at  INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_research_chunks_kind ON research_chunks(kind);
      `);
      try {
        this.db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS research_fts USING fts5(
            title, content, content='research_chunks', content_rowid='id'
          );
          CREATE TRIGGER IF NOT EXISTS research_ai AFTER INSERT ON research_chunks BEGIN
            INSERT INTO research_fts(rowid, title, content) VALUES (new.id, new.title, new.content);
          END;
          CREATE TRIGGER IF NOT EXISTS research_ad AFTER DELETE ON research_chunks BEGIN
            INSERT INTO research_fts(research_fts, rowid, title, content) VALUES ('delete', old.id, old.title, old.content);
          END;
        `);
      } catch (err) {
        log.warn("FTS5 unavailable", { err: err instanceof Error ? err.message : String(err) });
      }

      // sqlite-vec — the semantic half. If the extension won't load, we run
      // keyword-only (still fully functional).
      try {
        sqliteVec.load(this.db);
        // Rebuild the vec table if its declared dimension changed (e.g. the
        // embedding model was swapped). Vectors are regenerable, so dropping a
        // stale-dim table is safe — and we only do it on a real mismatch, so
        // vectors survive ordinary restarts.
        const existing = this.db.query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE name='research_vec'`).get();
        if (existing && !existing.sql.includes(`float[${EMBED_DIM}]`)) {
          log.warn(`research_vec dimension changed → rebuilding as float[${EMBED_DIM}]`);
          this.db.exec(`DROP TABLE research_vec`);
        }
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS research_vec USING vec0(embedding float[${EMBED_DIM}])`);
        this.vecAvailable = true;
      } catch (err) {
        log.warn("sqlite-vec unavailable — keyword-only", { err: err instanceof Error ? err.message : String(err) });
        this.vecAvailable = false;
      }
      log.info(`DB ready: ${this.dbPath} (vec=${this.vecAvailable}, dim=${EMBED_DIM})`);
    } catch (err) {
      log.error("DB init failed", { err: err instanceof Error ? err.message : String(err) });
      this.db = null;
    }
  }

  /** Ingest a chunk: row + FTS + (best-effort) embedding. Returns the id or null. */
  async addChunk(input: ResearchChunkInput): Promise<number | null> {
    if (!this.db || !input.content.trim()) return null;
    try {
      const res = this.db
        .query(`INSERT INTO research_chunks (kind, title, content, source, source_type, url, metadata, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.kind,
          input.title ?? null,
          input.content,
          input.source ?? null,
          input.sourceType ?? null,
          input.url ?? null,
          input.metadata ? JSON.stringify(input.metadata) : null,
          Date.now(),
        );
      const id = Number(res.lastInsertRowid);
      if (this.vecAvailable) await this._embedInto(id, `${input.title ?? ""}\n${input.content}`.trim());
      return id;
    } catch (err) {
      log.warn("addChunk failed", { err: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private async _embedInto(id: number, text: string): Promise<void> {
    const vec = await embed(text).catch(() => null);
    if (!vec || vec.length !== EMBED_DIM) return; // embeddings down or dim mismatch → keyword-only for this chunk
    try {
      const blob = new Uint8Array(new Float32Array(vec).buffer);
      this.db!.query(`INSERT INTO research_vec(rowid, embedding) VALUES (?, ?)`).run(id, blob);
    } catch (err) {
      log.warn(`vector insert failed for ${id}`, { err: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Lexical BM25 ranks: [{id, rank}], best first. */
  private _keywordRanked(query: string, k: number, kind?: ResearchKind): Array<{ id: number }> {
    if (!this.db) return [];
    const tokens = (query.match(/[\w']+/g) ?? []).filter((t) => t.length > 1);
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    try {
      const sql = kind
        ? `SELECT c.id FROM research_fts f JOIN research_chunks c ON c.id=f.rowid WHERE research_fts MATCH ? AND c.kind=? ORDER BY rank LIMIT ?`
        : `SELECT c.id FROM research_fts f JOIN research_chunks c ON c.id=f.rowid WHERE research_fts MATCH ? ORDER BY rank LIMIT ?`;
      return kind
        ? this.db.query<{ id: number }, [string, string, number]>(sql).all(match, kind, k)
        : this.db.query<{ id: number }, [string, number]>(sql).all(match, k);
    } catch {
      return [];
    }
  }

  /** Semantic KNN ranks: [{id}], nearest first. */
  private async _vectorRanked(query: string, k: number): Promise<Array<{ id: number }>> {
    if (!this.db || !this.vecAvailable) return [];
    const vec = await embed(query).catch(() => null);
    if (!vec || vec.length !== EMBED_DIM) return [];
    try {
      const blob = new Uint8Array(new Float32Array(vec).buffer);
      return this.db
        .query<{ id: number }, [Uint8Array, number]>(
          `SELECT rowid AS id FROM research_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
        )
        .all(blob, k);
    } catch {
      return [];
    }
  }

  /**
   * Reciprocal Rank Fusion of lexical + semantic results. Falls back cleanly to
   * whichever signal is available (keyword-only when vectors are off).
   */
  async hybridSearch(query: string, k = 5, kind?: ResearchKind): Promise<ResearchHit[]> {
    if (!this.db) return [];
    const pool = Math.max(k * 4, 20);
    const [kw, vec] = await Promise.all([
      Promise.resolve(this._keywordRanked(query, pool, kind)),
      this._vectorRanked(query, pool),
    ]);
    const scores = new Map<number, number>();
    kw.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (RRF_K + i)));
    vec.forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1 / (RRF_K + i)));
    const topIds = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
    return topIds.map(([id, score]) => this._hydrate(id, score)).filter((h): h is ResearchHit => h !== null);
  }

  private _hydrate(id: number, score: number): ResearchHit | null {
    if (!this.db) return null;
    const row = this.db
      .query<{ id: number; kind: string; title: string | null; content: string; source: string | null; url: string | null }, [number]>(
        `SELECT id, kind, title, content, source, url FROM research_chunks WHERE id = ?`,
      )
      .get(id);
    if (!row) return null;
    const preview = row.content.length > PREVIEW_CHARS ? row.content.slice(0, PREVIEW_CHARS) + "…" : row.content;
    return { id: row.id, kind: row.kind as ResearchKind, title: row.title, preview, source: row.source, url: row.url, score };
  }

  /** Row counts per kind — for the research_memory `stats` action. */
  stats(): Record<string, number> {
    if (!this.db) return {};
    try {
      const rows = this.db.query<{ kind: string; n: number }, []>(`SELECT kind, count(*) n FROM research_chunks GROUP BY kind`).all();
      const out: Record<string, number> = {};
      let total = 0;
      for (const r of rows) { out[r.kind] = r.n; total += r.n; }
      out.total = total;
      return out;
    } catch {
      return {};
    }
  }

  close(): void {
    if (this.db) {
      try { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* ignore */ }
      this.db.close();
      this.db = null;
    }
  }
}
