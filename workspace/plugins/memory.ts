import type { Plugin, EventBus, BusMessage } from "../../lib/types";

/**
 * MemoryPlugin — bus-native interface to the mem0 self-hosted API.
 *
 * Topics:
 *   memory.add    { userId, agentId?, messages: [{role, content}], metadata? }
 *   memory.search { userId, agentId?, query, limit? }  → reply.topic with { memories }
 *   memory.get    { userId, agentId? }                 → reply.topic with { memories }
 *   memory.delete { memoryId }
 */

interface Mem0Memory {
  id: string;
  memory: string;
  user_id?: string;
  agent_id?: string;
  score?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export class MemoryPlugin implements Plugin {
  name = "memory";
  description = "Explicit memory storage and retrieval via mem0";
  capabilities: string[] = ["memory", "recall"];

  private bus: EventBus | null = null;
  private baseUrl: string;
  private apiKey: string | undefined;

  constructor(
    baseUrl = process.env.MEM0_BASE_URL || "http://mem0:8000",
    apiKey = process.env.MEM0_API_KEY,
  ) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  install(bus: EventBus): void {
    this.bus = bus;
    bus.subscribe("memory.add",    this.name, (msg) => this.handleAdd(msg));
    bus.subscribe("memory.search", this.name, (msg) => this.handleSearch(msg));
    bus.subscribe("memory.get",    this.name, (msg) => this.handleGet(msg));
    bus.subscribe("memory.delete", this.name, (msg) => this.handleDelete(msg));
    console.log(`[memory] Connected to mem0 at ${this.baseUrl}`);
  }

  uninstall(): void {}

  // --- Handlers ---

  private async handleAdd(msg: BusMessage): Promise<void> {
    const p = msg.payload as {
      userId: string;
      agentId?: string;
      messages: { role: string; content: string }[];
      metadata?: Record<string, unknown>;
    };

    try {
      await this.request("POST", "/memories", {
        messages: p.messages,
        user_id: p.userId,
        ...(p.agentId ? { agent_id: p.agentId } : {}),
        ...(p.metadata ? { metadata: p.metadata } : {}),
      });
    } catch (err) {
      console.error("[memory] add failed:", err);
    }
  }

  private async handleSearch(msg: BusMessage): Promise<void> {
    const p = msg.payload as {
      userId: string;
      agentId?: string;
      query: string;
      limit?: number;
    };

    try {
      const data = await this.request("POST", "/search", {
        query: p.query,
        user_id: p.userId,
        ...(p.agentId ? { agent_id: p.agentId } : {}),
        limit: p.limit ?? 10,
      }) as { results?: Mem0Memory[] };

      this.reply(msg, { memories: data.results ?? [] });
    } catch (err) {
      console.error("[memory] search failed:", err);
      this.reply(msg, { memories: [], error: String(err) });
    }
  }

  private async handleGet(msg: BusMessage): Promise<void> {
    const p = msg.payload as { userId: string; agentId?: string };
    const params = new URLSearchParams({ user_id: p.userId });
    if (p.agentId) params.set("agent_id", p.agentId);

    try {
      const data = await this.request("GET", `/memories?${params}`) as { results?: Mem0Memory[] };
      this.reply(msg, { memories: data.results ?? [] });
    } catch (err) {
      console.error("[memory] get failed:", err);
      this.reply(msg, { memories: [], error: String(err) });
    }
  }

  private async handleDelete(msg: BusMessage): Promise<void> {
    const p = msg.payload as { memoryId: string };
    try {
      await this.request("DELETE", `/memories/${p.memoryId}`);
    } catch (err) {
      console.error("[memory] delete failed:", err);
    }
  }

  // --- Helpers ---

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!res.ok) throw new Error(`mem0 ${method} ${path} → ${res.status}`);
    return res.json();
  }

  private reply(msg: BusMessage, payload: unknown): void {
    if (!this.bus || !msg.reply?.topic) return;
    this.bus.publish(msg.reply.topic, {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: msg.reply.topic,
      timestamp: Date.now(),
      payload,
    });
  }
}

export default new MemoryPlugin();
