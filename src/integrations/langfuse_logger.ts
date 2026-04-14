import type { GoalViolation } from "../types/goals.ts";
import { HttpClient } from "../services/http-client.ts";
import { TOPICS } from "../event-bus/topics.ts";

interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  host: string;
}

interface LangfuseEvent {
  id: string;
  type: "event";
  timestamp: string;
  name: string;
  metadata?: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
}

/**
 * Langfuse integration for goal violation logging.
 * Uses the Langfuse HTTP ingestion API directly (no SDK dependency).
 * Falls back to console logging on failure.
 */
export class LangfuseLogger {
  private config: LangfuseConfig | null;
  private buffer: LangfuseEvent[] = [];
  private readonly http: HttpClient;

  constructor() {
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    const host = process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com";

    if (!publicKey || !secretKey) {
      console.info("[langfuse] LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY not set — using console fallback");
      this.config = null;
    } else {
      this.config = { publicKey, secretKey, host };
    }
    this.http = new HttpClient({ timeoutMs: 10_000 });
  }

  /** Log a goal violation event. Returns true if sent, false on error/fallback. */
  async logViolation(violation: GoalViolation): Promise<boolean> {
    const event: LangfuseEvent = {
      id: crypto.randomUUID(),
      type: "event",
      timestamp: new Date(violation.timestamp).toISOString(),
      name: TOPICS.WORLD_GOAL_VIOLATED,
      metadata: {
        goalId: violation.goalId,
        goalType: violation.goalType,
        severity: violation.severity,
        projectSlug: violation.projectSlug,
      },
      input: { worldState: violation.actual },
      output: {
        message: violation.message,
        actual: violation.actual,
        expected: violation.expected,
      },
    };

    if (!this.config) {
      console.log(`[langfuse:fallback] Goal violation: ${violation.goalId} — ${violation.message}`);
      return false;
    }

    try {
      await this._sendBatch([event]);
      return true;
    } catch (err) {
      console.error("[langfuse] Integration error — falling back to console:", err);
      console.log(`[langfuse:fallback] Goal violation: ${violation.goalId} — ${violation.message}`);
      return false;
    }
  }

  /** Buffer a violation for batch sending. */
  bufferViolation(violation: GoalViolation): void {
    const event: LangfuseEvent = {
      id: crypto.randomUUID(),
      type: "event",
      timestamp: new Date(violation.timestamp).toISOString(),
      name: TOPICS.WORLD_GOAL_VIOLATED,
      metadata: {
        goalId: violation.goalId,
        goalType: violation.goalType,
        severity: violation.severity,
        projectSlug: violation.projectSlug,
      },
      input: { worldState: violation.actual },
      output: {
        message: violation.message,
        actual: violation.actual,
        expected: violation.expected,
      },
    };
    this.buffer.push(event);
  }

  /** Flush all buffered events in a single batch request. */
  async flush(): Promise<boolean> {
    if (this.buffer.length === 0) return true;

    const events = [...this.buffer];
    this.buffer = [];

    if (!this.config) {
      for (const e of events) {
        console.log(`[langfuse:fallback] Flushing event: ${e.name} — ${e.id}`);
      }
      return false;
    }

    try {
      await this._sendBatch(events);
      return true;
    } catch (err) {
      console.error("[langfuse] Batch flush error:", err);
      return false;
    }
  }

  private async _sendBatch(events: LangfuseEvent[]): Promise<void> {
    const { publicKey, secretKey, host } = this.config!;
    const credentials = btoa(`${publicKey}:${secretKey}`);

    await this.http.post(`${host}/api/public/ingestion`, { batch: events }, {
      auth: { type: "basic", credentials },
    });
  }
}
