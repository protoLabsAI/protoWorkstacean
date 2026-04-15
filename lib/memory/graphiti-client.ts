/**
 * GraphitiClient — user memory via Graphiti (Zep OSS temporal knowledge graph).
 *
 * Graphiti runs as a sidecar container, stores data in the shared research-neo4j
 * instance. Each user gets a scoped group_id so facts never bleed across users.
 *
 * Key operations:
 *   getContextBlock()  — retrieve relevant facts before routing a message
 *   addEpisode()       — store a completed conversation turn after agent responds
 *   clearUser()        — wipe all memory for a user (GDPR / admin command)
 *
 * API reference: POST /messages, POST /get-memory, POST /search,
 *                DELETE /group/{group_id}, GET /healthcheck
 */

export interface GraphitiFact {
  uuid: string;
  name: string;
  fact: string;
  valid_at: string | null;
  invalid_at: string | null;
  created_at: string;
  expired_at: string | null;
}

interface GraphitiMessage {
  content: string;
  role_type: "user" | "assistant" | "system";
  role?: string;
  name?: string;
  timestamp?: string;
  source_description?: string;
}

export class GraphitiClient {
  private readonly baseUrl: string;

  constructor() {
    this.baseUrl = (process.env.GRAPHITI_URL ?? "http://graphiti:8000").replace(/\/$/, "");
  }

  /**
   * Retrieve relevant facts for a user given the current message.
   * Uses /get-memory so Graphiti can build the best query from context.
   * Returns a formatted [User context] block, or "" if no facts found.
   *
   * @param groupId  Canonical group ID — use IdentityRegistry.groupId() to resolve.
   *                 Falls back to "user_{platform}_{userId}" if unresolved.
   *                 MUST use only alphanumeric, dashes, underscores — colons
   *                 will crash graphiti's ingestion worker silently.
   */
  async getContextBlock(
    groupId: string,
    currentMessage: string,
  ): Promise<string> {

    // Graphiti's /get-memory requires center_node_uuid (even when null)
    // and Message.role (even when blank). Omitting either causes 422.
    const result = await this._post<{ facts: GraphitiFact[] }>("/get-memory", {
      group_id: groupId,
      center_node_uuid: null,
      messages: [{ content: currentMessage, role_type: "user", role: "" }],
      max_facts: 15,
    });

    const facts = result?.facts ?? [];
    if (facts.length === 0) return "";

    // Filter out expired/invalidated facts
    const now = Date.now();
    const active = facts.filter(f => {
      if (f.invalid_at && new Date(f.invalid_at).getTime() <= now) return false;
      if (f.expired_at && new Date(f.expired_at).getTime() <= now) return false;
      return true;
    });

    if (active.length === 0) return "";

    const lines = active.map(f => `- ${f.fact}`);
    return `[User context — ${groupId}]\n${lines.join("\n")}\n`;
  }

  /**
   * Store a completed conversation turn (user message + agent response).
   * Call this fire-and-forget after the agent reply is sent.
   * Graphiti handles extraction, dedup, and contradiction resolution.
   */
  async addEpisode(params: {
    groupId: string;
    userMessage: string;
    agentMessage: string;
    /** Role label for the user turn (e.g. display name or canonical id) */
    userRole?: string;
    agentName?: string;
    channelId?: string;
    platform?: string;
    timestamp?: Date;
    /** Sequential turn number within the conversation — used to reconstruct threading. */
    turnNumber?: number;
    /** ID of the parent turn — used to reconstruct threading across correlated exchanges. */
    parentTurnId?: string;
  }): Promise<void> {
    const ts = (params.timestamp ?? new Date()).toISOString();
    let source = params.channelId && params.platform
      ? `${params.platform} channel ${params.channelId}`
      : (params.platform ?? "unknown");
    if (params.turnNumber !== undefined) source += ` | turn:${params.turnNumber}`;
    if (params.parentTurnId !== undefined) source += ` | parent:${params.parentTurnId}`;

    await this._post("/messages", {
      group_id: params.groupId,
      messages: [
        {
          content: params.userMessage,
          role_type: "user",
          role: params.userRole ?? params.groupId,
          timestamp: ts,
          source_description: source,
        },
        {
          content: params.agentMessage,
          role_type: "assistant",
          role: params.agentName ?? "assistant",
          timestamp: ts,
          source_description: source,
        },
      ],
    });
  }

  /** Delete all memory for a user (cascades to all episodes, entities, edges). */
  async clearUser(groupId: string): Promise<void> {
    await this._delete(`/group/${encodeURIComponent(groupId)}`);
  }

  /** Direct fact search — useful for slash commands like /memory search <query>. */
  async search(
    groupId: string,
    query: string,
    maxFacts = 10,
  ): Promise<GraphitiFact[]> {
    const result = await this._post<{ facts: GraphitiFact[] }>("/search", {
      query,
      group_ids: [groupId],
      max_facts: maxFacts,
    });
    return result?.facts ?? [];
  }

  async isHealthy(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl}/healthcheck`, {
        signal: AbortSignal.timeout(3_000),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  private async _post<T>(path: string, body: unknown): Promise<T | null> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Graphiti ${path} error ${resp.status}: ${text}`);
    }

    // /messages returns 202 with no body worth parsing
    if (resp.status === 202) return null;
    return resp.json() as Promise<T>;
  }

  private async _delete(path: string): Promise<void> {
    const resp = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Graphiti DELETE ${path} error ${resp.status}: ${text}`);
    }
  }
}
