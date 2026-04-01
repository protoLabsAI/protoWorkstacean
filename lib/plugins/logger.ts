import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import type { Plugin, EventBus, BusMessage } from "../types";

export class LoggerPlugin implements Plugin {
  name = "logger";
  description = "Event log subscriber - writes all messages to SQLite";
  capabilities: string[] = ["persist", "query"];

  private db: Database | null = null;
  private subscriptionId: string | null = null;

  install(bus: EventBus): void {
    const dbDir = "data";
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    this.db = new Database(`${dbDir}/events.db`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT NOT NULL,
        topic TEXT NOT NULL,
        payload TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        source TEXT NOT NULL
      )
    `);

    this.subscriptionId = bus.subscribe("#", this.name, (msg: BusMessage) => {
      this.log(msg);
    });
  }

  uninstall(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private log(msg: BusMessage): void {
    if (!this.db) return;
    
    this.db.run(
      "INSERT INTO events (id, topic, payload, timestamp, source) VALUES (?, ?, ?, ?, ?)",
      [msg.id, msg.topic, JSON.stringify(msg), msg.timestamp, msg.topic.split(".")[0]]
    );
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
      "SELECT payload FROM events WHERE id = ? ORDER BY timestamp ASC"
    ).all(correlationId) as { payload: string }[];
    return rows.map(row => JSON.parse(row.payload));
  }
}