/**
 * TaskTrackerStore — durable backing for in-flight A2A task tracking.
 *
 * The TaskTracker keeps a Map of tasks that returned non-terminal ("working")
 * and owes each caller a reply on its reply topic. That Map was purely
 * in-memory, so a restart (watchtower auto-pulls several times a day) silently
 * dropped every owed reply. This store persists the serializable task record so
 * the tracker can rehydrate on boot, resume polling once the agent's executor
 * re-registers, and — if it never does — escalate rather than drop.
 *
 * Only serializable fields are stored; the live `executor` reference and the
 * `onTerminal` callback are reconstructed/omitted on rehydration.
 *
 * Failure modes: a DB open/IO failure is logged loudly and the store degrades
 * to a no-op (tracking falls back to in-memory-only) rather than crashing.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface PersistedTask {
  correlationId: string;
  taskId: string;
  agentName: string;
  skillName?: string;
  dispatcherAgent?: string;
  replyTopic: string;
  parentId?: string;
  registeredAt: number;
  pollIntervalMs: number;
  callbackToken?: string;
  sourceInterface?: string;
  sourceChannelId?: string;
  sourceUserId?: string;
}

interface Row {
  correlation_id: string;
  task_id: string;
  agent_name: string;
  skill_name: string | null;
  dispatcher_agent: string | null;
  reply_topic: string;
  parent_id: string | null;
  registered_at: number;
  poll_interval_ms: number;
  callback_token: string | null;
  source_interface: string | null;
  source_channel_id: string | null;
  source_user_id: string | null;
}

export class TaskTrackerStore {
  private db: Database | null = null;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = resolve(dbPath);
    try {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.db = new Database(this.dbPath);
      this.db.exec("PRAGMA journal_mode=WAL;");
      this.db.exec("PRAGMA synchronous=NORMAL;");
      this.db.exec("PRAGMA busy_timeout=5000;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tracked_tasks (
          correlation_id   TEXT PRIMARY KEY,
          task_id          TEXT NOT NULL,
          agent_name       TEXT NOT NULL,
          skill_name       TEXT,
          dispatcher_agent TEXT,
          reply_topic      TEXT NOT NULL,
          parent_id        TEXT,
          registered_at    INTEGER NOT NULL,
          poll_interval_ms INTEGER NOT NULL,
          callback_token   TEXT,
          source_interface TEXT,
          source_channel_id TEXT,
          source_user_id   TEXT
        );
      `);
      console.log(`[task-store] Ready at ${this.dbPath}`);
    } catch (err) {
      console.error("[task-store] Init failed — task persistence disabled (in-memory only):", err);
      this.db = null;
    }
  }

  upsert(t: PersistedTask): void {
    if (!this.db) return;
    try {
      this.db.query(
        `INSERT INTO tracked_tasks
           (correlation_id, task_id, agent_name, skill_name, dispatcher_agent, reply_topic,
            parent_id, registered_at, poll_interval_ms, callback_token,
            source_interface, source_channel_id, source_user_id)
         VALUES ($cid, $tid, $agent, $skill, $disp, $reply, $parent, $reg, $poll, $token, $si, $sc, $su)
         ON CONFLICT(correlation_id) DO UPDATE SET
           task_id=$tid, agent_name=$agent, skill_name=$skill, dispatcher_agent=$disp,
           reply_topic=$reply, parent_id=$parent, registered_at=$reg, poll_interval_ms=$poll,
           callback_token=$token, source_interface=$si, source_channel_id=$sc, source_user_id=$su`,
      ).run({
        $cid: t.correlationId, $tid: t.taskId, $agent: t.agentName, $skill: t.skillName ?? null,
        $disp: t.dispatcherAgent ?? null, $reply: t.replyTopic, $parent: t.parentId ?? null,
        $reg: t.registeredAt, $poll: t.pollIntervalMs, $token: t.callbackToken ?? null,
        $si: t.sourceInterface ?? null, $sc: t.sourceChannelId ?? null, $su: t.sourceUserId ?? null,
      });
    } catch (err) {
      console.warn(`[task-store] upsert ${t.correlationId} failed:`, err);
    }
  }

  delete(correlationId: string): void {
    if (!this.db) return;
    try {
      this.db.query("DELETE FROM tracked_tasks WHERE correlation_id = $cid").run({ $cid: correlationId });
    } catch (err) {
      console.warn(`[task-store] delete ${correlationId} failed:`, err);
    }
  }

  loadAll(): PersistedTask[] {
    if (!this.db) return [];
    try {
      const rows = this.db.query("SELECT * FROM tracked_tasks").all() as Row[];
      return rows.map((r) => ({
        correlationId: r.correlation_id,
        taskId: r.task_id,
        agentName: r.agent_name,
        skillName: r.skill_name ?? undefined,
        dispatcherAgent: r.dispatcher_agent ?? undefined,
        replyTopic: r.reply_topic,
        parentId: r.parent_id ?? undefined,
        registeredAt: r.registered_at,
        pollIntervalMs: r.poll_interval_ms,
        callbackToken: r.callback_token ?? undefined,
        sourceInterface: r.source_interface ?? undefined,
        sourceChannelId: r.source_channel_id ?? undefined,
        sourceUserId: r.source_user_id ?? undefined,
      }));
    } catch (err) {
      console.warn("[task-store] loadAll failed:", err);
      return [];
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
