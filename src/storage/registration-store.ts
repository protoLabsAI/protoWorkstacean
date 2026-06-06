/**
 * RegistrationStore — durable home for control-plane-managed agent
 * registrations (bun:sqlite, on the data volume).
 *
 * The write API (`POST /api/a2a-endpoints`) materializes a registration as a
 * drop-in yaml file under `workspace/agents.d/`. But that lives in the
 * *ephemeral* workspace clone — a redeploy from a fresh clone (or a `git
 * clean`) wipes it, so an API-driven registration silently vanishes (#850).
 *
 * This store persists the same registration to `${dataDir}/registrations.db`
 * (the durable volume that already holds events.db / knowledge.db / tasks.db).
 * The `agents.d/` file becomes a cache: ControlPlaneRegistrarPlugin writes both
 * on upsert, removes both on delete, and re-materializes the cache from this
 * store on boot — so an API registration survives any number of redeploys
 * without re-running `make register`.
 *
 * `kind` namespaces the runtime-written config roots (today: "a2a"; "mcp" is a
 * trivial future addition). The git-tracked `workspace/agents/` root is NOT
 * persisted here — those files have a durable home in git already.
 *
 * Degrades to a no-op when the DB is unavailable, exactly like the other
 * sqlite-backed stores — a persistence outage must never block a live
 * registration (the in-memory + agents.d/ path still works for the session).
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "../../lib/log.ts";

const log = logger("registration-store");

export interface StoredRegistration {
  name: string;
  yaml: string;
}

export class RegistrationStore {
  private db: Database | null = null;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = resolve(dbPath);
    this._init();
  }

  private _init(): void {
    try {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.db = new Database(this.dbPath);
      this.db.exec("PRAGMA journal_mode=WAL;");
      this.db.exec("PRAGMA synchronous=NORMAL;");
      this.db.exec("PRAGMA busy_timeout=5000;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS registrations (
          kind       TEXT NOT NULL,
          name       TEXT NOT NULL,
          yaml       TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (kind, name)
        );
      `);
      log.info(`Ready at ${this.dbPath}`);
    } catch (err) {
      log.error("Init failed — registration persistence disabled", { err });
      this.db = null;
    }
  }

  /** Persist (or replace) a registration's yaml. */
  upsert(kind: string, name: string, yaml: string): void {
    if (!this.db) return;
    try {
      this.db.run(
        `INSERT INTO registrations (kind, name, yaml, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(kind, name) DO UPDATE SET
           yaml = excluded.yaml,
           updated_at = excluded.updated_at`,
        [kind, name, yaml, Date.now()],
      );
    } catch (err) {
      log.error(`upsert "${kind}/${name}" failed`, { err });
    }
  }

  /** Forget a registration (it was unregistered via the API). */
  remove(kind: string, name: string): void {
    if (!this.db) return;
    try {
      this.db.run(`DELETE FROM registrations WHERE kind = ? AND name = ?`, [kind, name]);
    } catch (err) {
      log.error(`remove "${kind}/${name}" failed`, { err });
    }
  }

  /** All persisted registrations of a kind — used to re-materialize the cache on boot. */
  all(kind: string): StoredRegistration[] {
    if (!this.db) return [];
    try {
      return this.db
        .query<{ name: string; yaml: string }, [string]>(
          `SELECT name, yaml FROM registrations WHERE kind = ? ORDER BY name`,
        )
        .all(kind);
    } catch (err) {
      log.error(`all("${kind}") failed`, { err });
      return [];
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // already closed / never opened
    }
    this.db = null;
  }
}
