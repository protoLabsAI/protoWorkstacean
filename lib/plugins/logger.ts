import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin, EventBus, BusMessage, LoggerTurnQueryRequest, LoggerTurnQueryResponse, ConversationTurn } from "../types";
import { logger } from "../log.ts";

const log = logger("event-logger");

/** Object keys whose values are masked before an event is persisted (#801). */
const SECRET_KEY_RE = /(token|secret|password|passwd|api[-_]?key|private[-_]?key|authorization|bearer|refresh[-_]?token|client[-_]?secret|credential)/i;

/**
 * Deep-clone `value`, masking any property whose KEY looks secret-bearing, so
 * the events.db sink (which persists every bus message) never stores tokens /
 * OAuth state in cleartext. Free-text content is left intact — only key-named
 * secrets are redacted. Cyclic refs are guarded.
 */
export function redactSecrets(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value as object)) return "[circular]";
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) && v != null && v !== "" ? "[redacted]" : redactSecrets(v, seen);
  }
  return out;
}

export class LoggerPlugin implements Plugin {
  name = "logger";
  description = "Event log subscriber - writes all messages to SQLite";
  capabilities: string[] = ["persist", "query"];

  private db: Database | null = null;
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private subscriptionId: string | null = null;
  private querySubscriptionId: string | null = null;
  private bus: EventBus | null = null;
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
  }

  install(bus: EventBus): void {
    if (!existsSync(this.dataDir)) {
      mkdirSync(this.dataDir, { recursive: true });
    }

    this.db = new Database(`${this.dataDir}/events.db`);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA busy_timeout=5000;");
    // INCREMENTAL auto-vacuum so retention deletes can return freed pages via
    // `PRAGMA incremental_vacuum` (the hourly sweep) instead of a full locking
    // VACUUM. CRITICAL: auto_vacuum can only change on an EXISTING db via a
    // VACUUM rebuild — the PRAGMA alone is a no-op on a db created NONE. Legacy
    // DBs (pre-#801) were stuck at NONE, so retention deleted rows but
    // incremental_vacuum couldn't reclaim them and the file grew unbounded
    // (observed: a 42 GB file holding 0.7 GB of live events). Migrate once:
    // set INCREMENTAL, then VACUUM to apply it + reclaim. Runs on our own
    // connection at install (before writes); ∝ LIVE data, which retention keeps
    // small. After the first run auto_vacuum is 2, so this is skipped. (#801)
    const avBefore = (this.db.query("PRAGMA auto_vacuum").get() as { auto_vacuum?: number } | undefined)?.auto_vacuum ?? 0;
    this.db.exec("PRAGMA auto_vacuum=INCREMENTAL;");
    if (avBefore !== 2) {
      log.warn(`events.db auto_vacuum=${avBefore} (not INCREMENTAL) — rebuilding once to reclaim free pages`);
      try {
        this.db.exec("VACUUM;");
      } catch (err) {
        log.error("events.db VACUUM migration failed (continuing — retention still bounds rows)", { err });
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        parent_id TEXT,
        topic TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        source TEXT NOT NULL
      )
    `);

    // Migrate: add missing columns if upgrading from old schema
    const columns = this.db.query("PRAGMA table_info(events)").all() as { name: string }[];
    if (!columns.some(c => c.name === "correlation_id")) {
      this.db.exec("ALTER TABLE events ADD COLUMN correlation_id TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.some(c => c.name === "parent_id")) {
      this.db.exec("ALTER TABLE events ADD COLUMN parent_id TEXT");
    }

    this.bus = bus;

    this.subscriptionId = bus.subscribe("#", this.name, (msg: BusMessage) => {
      if (msg.topic.startsWith("debug.")) return;
      this.log(msg);
    });

    // Retention: this sink subscribes to `#` (every bus message), so without a
    // sweep events.db grows without bound on the data volume. Purge rows older
    // than the window + reclaim space. (#801)
    this._sweepRetention();
    this.retentionTimer = setInterval(() => this._sweepRetention(), 60 * 60_000);
    this.retentionTimer.unref?.();

    this.querySubscriptionId = bus.subscribe("logger.turn.query", this.name, (msg: BusMessage) => {
      const req = msg.payload as LoggerTurnQueryRequest;
      const turns = this.getRecentTurnsForUser(req.userId, req.agentName, req.limit, req.maxAgeMs);
      const response: LoggerTurnQueryResponse = { type: "logger.turn.query.response", turns };
      bus.publish(req.replyTopic, {
        id: crypto.randomUUID(),
        correlationId: msg.correlationId,
        parentId: msg.id,
        topic: req.replyTopic,
        timestamp: Date.now(),
        payload: response,
      });
    });
  }

  uninstall(): void {
    if (this.retentionTimer) {
      clearInterval(this.retentionTimer);
      this.retentionTimer = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private log(msg: BusMessage): void {
    if (!this.db) return;
    // Redact secret-keyed fields before persisting — this sink stores the whole
    // message and would otherwise write tokens/OAuth state in cleartext. (#801)
    const safe = redactSecrets(msg);
    this.db.run(
      "INSERT INTO events (id, correlation_id, parent_id, topic, payload, timestamp, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [msg.id, msg.correlationId, msg.parentId ?? null, msg.topic, JSON.stringify(safe), msg.timestamp, msg.topic.split(".")[0]]
    );
  }

  /** Delete events older than the retention window + reclaim freed pages. */
  private _sweepRetention(): void {
    if (!this.db) return;
    const ms = Number(process.env.LOGGER_EVENTS_RETENTION_MS) || 7 * 24 * 60 * 60_000;
    try {
      const cutoff = Date.now() - ms;
      const deleted = this.db.run("DELETE FROM events WHERE timestamp < ?", [cutoff]);
      this.db.exec("PRAGMA incremental_vacuum;");
      if ((deleted as { changes?: number }).changes) {
        log.info(`retention sweep: purged ${(deleted as { changes?: number }).changes} event(s) older than ${Math.round(ms / 86400000)}d`);
      }
    } catch (err) {
      log.warn("retention sweep failed", { err });
    }
  }

  getEvents(limit: number = 100): BusMessage[] {
    if (!this.db) return [];
    
    const rows = this.db.query("SELECT payload FROM events ORDER BY timestamp DESC LIMIT ?").all(limit) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload));
  }

  getEventsByTopic(topic: string, limit: number = 100): BusMessage[] {
    if (!this.db) return [];
    
    const rows = this.db.query(
      "SELECT payload FROM events WHERE topic LIKE ? ORDER BY timestamp DESC LIMIT ?"
    ).all(`${topic}%`, limit) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload));
  }

  getEventsByCorrelationId(correlationId: string): BusMessage[] {
    if (!this.db) return [];

    const rows = this.db.query(
      "SELECT payload FROM events WHERE correlation_id = ? ORDER BY timestamp ASC"
    ).all(correlationId) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload));
  }

  /**
   * Retrieve recent conversation turns for a canonical user.
   *
   * Uses only indexed columns (topic, timestamp, correlation_id) in SQL — no
   * JSON_EXTRACT. Application-level filtering resolves userId from parsed payloads.
   *
   * @param canonicalUserId  The user's canonical ID (matches BusMessage.source.userId).
   * @param agentName        Agent to scope turns to (matched against payload.targets).
   *                         Pass empty string to include turns for any agent.
   * @param limit            Maximum number of turns to return.
   * @param maxAgeMs         Only include turns within this many ms of now.
   */
  getRecentTurnsForUser(
    canonicalUserId: string,
    agentName: string,
    limit: number,
    maxAgeMs: number,
  ): ConversationTurn[] {
    if (!this.db) return [];

    const since = Date.now() - maxAgeMs;

    // Step 1: Fetch recent agent.skill.request events by indexed columns only.
    // Over-fetch so we have enough candidates after userId filtering.
    const candidateRows = this.db.query(
      "SELECT correlation_id, payload FROM events WHERE topic = 'agent.skill.request' AND timestamp >= ? ORDER BY timestamp DESC LIMIT ?"
    ).all(since, limit * 10) as { correlation_id: string; payload: string }[];

    // Step 2: Filter in application code — find correlationIds belonging to this user.
    const seenCorrelationIds = new Set<string>();
    const matchedCorrelationIds: string[] = [];

    for (const row of candidateRows) {
      if (matchedCorrelationIds.length >= limit) break;
      if (seenCorrelationIds.has(row.correlation_id)) continue;
      seenCorrelationIds.add(row.correlation_id);

      const msg = JSON.parse(row.payload) as BusMessage;
      if (msg.source?.userId !== canonicalUserId) continue;

      // If agentName provided, check payload.targets includes it (empty targets = any agent).
      if (agentName) {
        const payload = msg.payload as { targets?: string[] };
        const targets = payload?.targets;
        if (targets && targets.length > 0 && !targets.includes(agentName)) continue;
      }

      matchedCorrelationIds.push(row.correlation_id);
    }

    if (matchedCorrelationIds.length === 0) return [];

    // Step 3: Bulk-fetch all events for the matched correlationIds and assemble turns.
    const turns: ConversationTurn[] = [];

    for (const correlationId of matchedCorrelationIds) {
      const events = this.getEventsByCorrelationId(correlationId);
      const request = events.find(e => e.topic === "agent.skill.request");
      const response = events.find(e => e.topic.startsWith("agent.skill.response."));

      if (!request) continue;

      const reqPayload = request.payload as { skill?: string; content?: string; targets?: string[] };
      const channelId = request.source?.channelId ?? "";
      const agentName = reqPayload.targets?.[0] ?? "";

      turns.push({
        role: "user",
        text: reqPayload.content ?? "",
        channelId,
        agentName,
        timestamp: request.timestamp,
      });

      if (response) {
        const resPayload = response.payload as { content?: string; error?: string };
        turns.push({
          role: "assistant",
          text: resPayload.content ?? resPayload.error ?? "",
          channelId,
          agentName,
          timestamp: response.timestamp,
        });
      }
    }

    return turns;
  }
}