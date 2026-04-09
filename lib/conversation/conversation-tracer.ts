/**
 * ConversationTracer — Langfuse observability for multi-turn Discord conversations.
 *
 * Uses the Langfuse HTTP ingestion API (same pattern as langfuse_logger.ts).
 * Falls back to console logging when LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY
 * are not set.
 *
 * Data model:
 *   trace     — one per conversation (id = conversationId)
 *   generation — one per turn (traceId = conversationId, id = ${conversationId}-t${n})
 *
 * Call sequence:
 *   startTrace() — on first turn
 *   traceTurn()  — after each turn completes (has both input + output)
 *   endTrace()   — when conversation times out or is closed
 */

interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  host: string;
}

export interface TurnData {
  conversationId: string;
  turnNumber: number;
  input: string;
  output?: string;
  userId: string;
  agentName?: string;
  startTime: Date;
  endTime?: Date;
}

export class ConversationTracer {
  private config: LangfuseConfig | null;

  constructor() {
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    const host = process.env.LANGFUSE_HOST ?? process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";

    if (publicKey && secretKey) {
      this.config = { publicKey, secretKey, host };
    } else {
      this.config = null;
      console.info("[conversation-tracer] LANGFUSE keys not set — tracing disabled");
    }
  }

  /** Create the root trace for a new conversation. */
  async startTrace(params: {
    conversationId: string;
    userId: string;
    channelId: string;
    agentName?: string;
    platform: string;
  }): Promise<void> {
    if (!this.config) {
      console.log(`[conversation-tracer:fallback] Start conversation ${params.conversationId} (user ${params.userId})`);
      return;
    }

    try {
      await this._ingest([{
        id: crypto.randomUUID(),
        type: "trace-create",
        timestamp: new Date().toISOString(),
        body: {
          id: params.conversationId,
          name: `${params.platform}.conversation`,
          userId: params.userId,
          metadata: {
            channelId: params.channelId,
            agentName: params.agentName,
            platform: params.platform,
          },
          tags: ["conversation", params.platform],
        },
      }]);
    } catch (err) {
      console.error("[conversation-tracer] startTrace error:", err);
    }
  }

  /**
   * Record a completed conversation turn (input + output pair).
   * Call this when the agent response arrives, not when the user message arrives.
   */
  async traceTurn(data: TurnData): Promise<void> {
    if (!this.config) {
      console.log(
        `[conversation-tracer:fallback] Turn ${data.turnNumber} on ${data.conversationId}: ` +
        `"${data.input.slice(0, 60)}..." → "${(data.output ?? "").slice(0, 60)}..."`,
      );
      return;
    }

    const turnId = `${data.conversationId}-t${data.turnNumber}`;

    try {
      await this._ingest([{
        id: crypto.randomUUID(),
        type: "generation-create",
        timestamp: new Date().toISOString(),
        body: {
          id: turnId,
          traceId: data.conversationId,
          name: `turn.${data.turnNumber}`,
          model: data.agentName,
          startTime: data.startTime.toISOString(),
          endTime: (data.endTime ?? new Date()).toISOString(),
          input: data.input,
          output: data.output ?? null,
          metadata: {
            turnNumber: data.turnNumber,
            userId: data.userId,
          },
        },
      }]);
    } catch (err) {
      console.error(`[conversation-tracer] traceTurn error (turn ${data.turnNumber}):`, err);
    }
  }

  /**
   * Finalize the trace — updates metadata with end reason and total turns.
   * Called on timeout or explicit conversation end.
   */
  async endTrace(params: {
    conversationId: string;
    turnCount: number;
    endedBy: "timeout" | "user" | "system";
  }): Promise<void> {
    if (!this.config) {
      console.log(
        `[conversation-tracer:fallback] End conversation ${params.conversationId} ` +
        `(${params.turnCount} turns, ended by ${params.endedBy})`,
      );
      return;
    }

    try {
      await this._ingest([{
        id: crypto.randomUUID(),
        type: "trace-create", // idempotent merge by id
        timestamp: new Date().toISOString(),
        body: {
          id: params.conversationId,
          metadata: {
            endedBy: params.endedBy,
            totalTurns: params.turnCount,
            endedAt: new Date().toISOString(),
          },
        },
      }]);
    } catch (err) {
      console.error("[conversation-tracer] endTrace error:", err);
    }
  }

  private async _ingest(batch: unknown[]): Promise<void> {
    const { publicKey, secretKey, host } = this.config!;
    const credentials = btoa(`${publicKey}:${secretKey}`);

    const resp = await fetch(`${host}/api/public/ingestion`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({ batch }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Langfuse API error ${resp.status}: ${body}`);
    }
  }
}
