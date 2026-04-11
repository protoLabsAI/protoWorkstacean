/**
 * TODO(refactor): This file is 606 lines mixing engine + Redis + SQLite + HTTP
 * collector factory + MCP tool factory. When next touching, consider splitting:
 *   lib/plugins/world-state/engine.ts — core state machine, domain registry
 *   lib/plugins/world-state/redis-cache.ts — Redis fast-path + fallback
 *   lib/plugins/world-state/snapshot-store.ts — SQLite persistence
 *   lib/plugins/world-state/http-collector.ts — createHttpCollector factory
 *   lib/plugins/world-state/mcp-tool.ts — MCP tool factory
 *   lib/plugins/world-state-engine.ts — plugin shell
 *
 * WorldStateEngine — generic, application-agnostic world state machine.
 *
 * The engine makes no assumptions about what domains exist. Applications
 * register their own domains via registerDomain() or workspace/domains.yaml
 * (loaded by the config discovery layer in src/index.ts).
 *
 * Domain data shape is entirely owned by the application. The engine manages:
 *   - Per-domain tick scheduling (independent intervals)
 *   - Redis fast-path write layer (in-memory fallback when Redis unavailable)
 *   - knowledge.db persistent SQLite snapshots (every 5min by default)
 *   - Event bus publishing after every tick (world.state.{domain}, world.state.updated)
 *   - get_world_state MCP tool / bus tool API
 *
 * Inbound topics:
 *   tool.world_state.get       — bus-based world state query
 *   mcp.tool.get_world_state   — MCP tool invocation
 *
 * Outbound topics:
 *   world.state.{domain}       — after each domain tick
 *   world.state.updated        — after any domain update (full state)
 *   event.world_state.db_error — on knowledge.db write failures
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Plugin, EventBus, BusMessage } from "../types.ts";
import type { WorldState, WorldStateDomain, WorldStateSnapshot } from "../types/world-state.ts";
import { HttpClient } from "../../src/services/http-client.ts";

// ── Domain registration ───────────────────────────────────────────────────────

export type DomainCollector = () => Promise<unknown>;

interface DomainRegistration {
  name: string;
  collector: DomainCollector;
  tickMs: number;
  timer?: ReturnType<typeof setInterval>;
  tickCount: number;
  tickInProgress: boolean;
}

// ── Redis abstraction (graceful fallback to in-memory) ────────────────────────

interface RedisClient {
  set(key: string, value: string, options?: { ex?: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  quit(): Promise<unknown>;
}

class InMemoryRedis implements RedisClient {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  async set(key: string, value: string, options?: { ex?: number }): Promise<void> {
    const expiresAt = options?.ex ? Date.now() + options.ex * 1000 : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async quit(): Promise<void> {}
}

// ── Langfuse tracing abstraction (no-op fallback) ─────────────────────────────

interface TraceSpan {
  end(data?: Record<string, unknown>): void;
}

interface Tracer {
  startSpan(name: string, data?: Record<string, unknown>): TraceSpan;
  flush(): Promise<void>;
}

class NoopTracer implements Tracer {
  startSpan(_name: string, _data?: Record<string, unknown>): TraceSpan {
    return { end: () => {} };
  }
  async flush(): Promise<void> {}
}

// ── MCP tool interface ────────────────────────────────────────────────────────

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

// ── Engine ────────────────────────────────────────────────────────────────────

export class WorldStateEngine implements Plugin {
  readonly name = "world-state-engine";
  readonly description =
    "Generic world state machine — application-registered domains, Redis fast-path, SQLite snapshots";
  readonly capabilities = ["world_state", "get_world_state"];

  private bus?: EventBus;
  private readonly domains = new Map<string, DomainRegistration>();
  private readonly subscriptionIds: string[] = [];

  private redis: RedisClient = new InMemoryRedis();
  private tracer: Tracer = new NoopTracer();
  private db: Database | null = null;

  private worldState: WorldState = {
    timestamp: Date.now(),
    domains: {},
    extensions: {},
    snapshotVersion: 0,
  };

  private readonly knowledgeDbPath: string;
  private readonly snapshotIntervalMs: number;
  private snapshotTimer?: ReturnType<typeof setInterval>;
  private installed = false;

  constructor(options?: { knowledgeDbPath?: string; snapshotIntervalMs?: number }) {
    this.knowledgeDbPath = resolve(options?.knowledgeDbPath ?? "data/knowledge.db");
    this.snapshotIntervalMs = options?.snapshotIntervalMs ?? 300_000;
  }

  // ── Domain registration API ────────────────────────────────────────────────

  /**
   * Register a domain with a collector function and tick interval.
   * Can be called before or after install() — tickers start immediately if already installed.
   */
  registerDomain(name: string, collector: DomainCollector, tickMs: number): void {
    if (this.domains.has(name)) {
      // Stop old ticker before replacing
      const old = this.domains.get(name)!;
      if (old.timer) clearInterval(old.timer);
    }

    const reg: DomainRegistration = { name, collector, tickMs, tickCount: 0, tickInProgress: false };
    this.domains.set(name, reg);

    if (this.installed) {
      this._startTicker(reg);
      // Collect immediately on registration
      void this._collectDomain(reg).catch(err => {
        console.error(`[world-state-engine] Initial collect for "${name}" failed:`, err);
      });
    }

    console.log(`[world-state-engine] Domain "${name}" registered (tick: ${tickMs}ms)`);
  }

  // ── Plugin lifecycle ───────────────────────────────────────────────────────

  install(bus: EventBus): void {
    this.bus = bus;
    this.installed = true;

    this._initRedis();
    this._initLangfuse();
    this._initKnowledgeDb();

    // Subscribe to bus-based world state queries
    const subId = bus.subscribe("tool.world_state.get", this.name, async (msg: BusMessage) => {
      await this._handleGetWorldState(msg);
    });
    this.subscriptionIds.push(subId);

    const mcpSubId = bus.subscribe("mcp.tool.get_world_state", this.name, async (msg: BusMessage) => {
      await this._handleGetWorldState(msg);
    });
    this.subscriptionIds.push(mcpSubId);

    // Start tickers for any domains registered before install()
    for (const reg of this.domains.values()) {
      this._startTicker(reg);
      void this._collectDomain(reg).catch(err => {
        console.error(`[world-state-engine] Initial collect for "${reg.name}" failed:`, err);
      });
    }

    // Periodic SQLite snapshots
    this.snapshotTimer = setInterval(() => {
      this._persistSnapshot();
    }, this.snapshotIntervalMs);

    console.log(
      `[world-state-engine] Installed — ${this.domains.size} domain(s): ` +
      `${[...this.domains.keys()].join(", ") || "(none yet)"}`,
    );
  }

  uninstall(): void {
    for (const reg of this.domains.values()) {
      if (reg.timer) clearInterval(reg.timer);
      reg.timer = undefined;
    }

    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = undefined;
    }

    if (this.bus) {
      for (const id of this.subscriptionIds) {
        this.bus.unsubscribe(id);
      }
    }
    this.subscriptionIds.length = 0;
    this.installed = false;

    this.tracer.flush().catch(() => {});
    this.redis.quit().catch(() => {});

    if (this.db) {
      this.db.close();
      this.db = null;
    }

    console.log("[world-state-engine] Uninstalled");
  }

  // ── Public read API ────────────────────────────────────────────────────────

  getWorldState(options?: { domain?: string; maxAgeMs?: number }): WorldState | WorldStateDomain<unknown> | null {
    const maxAge = options?.maxAgeMs ?? 60_000;
    const now = Date.now();

    if (options?.domain) {
      const domainData = this.worldState.domains[options.domain];
      if (!domainData) return null;
      const age = now - domainData.metadata.collectedAt;
      if (age > maxAge) {
        console.warn(
          `[world-state-engine] Domain "${options.domain}" data is stale (age: ${age}ms, max: ${maxAge}ms) — returning null`,
        );
        return null;
      }
      return domainData;
    }

    return this.worldState;
  }

  getMCPTool(): MCPTool {
    return createGetWorldStateTool(this);
  }

  // ── Snapshot persistence ───────────────────────────────────────────────────

  writeSnapshot(): void {
    if (!this.db) {
      console.error("[world-state-engine] knowledge.db not available — snapshot skipped");
      return;
    }

    try {
      this.worldState.snapshotVersion += 1;
      const snapshot: WorldStateSnapshot = {
        worldState: this.worldState,
        createdAt: Date.now(),
        version: this.worldState.snapshotVersion,
      };

      this.db
        .query("INSERT INTO world_state_snapshots (version, created_at, snapshot) VALUES (?, ?, ?)")
        .run(snapshot.version, snapshot.createdAt, JSON.stringify(snapshot.worldState));

      // Keep last 50 snapshots
      this.db
        .query(
          "DELETE FROM world_state_snapshots WHERE id NOT IN " +
          "(SELECT id FROM world_state_snapshots ORDER BY created_at DESC LIMIT 50)",
        )
        .run();

      console.log(`[world-state-engine] Snapshot v${snapshot.version} written to knowledge.db`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[world-state-engine] Snapshot write failed: ${msg}`);
      this._emitDbError(`Snapshot write failed: ${msg}`);
    }
  }

  // ── Ticker scheduling ──────────────────────────────────────────────────────

  private _startTicker(reg: DomainRegistration): void {
    reg.timer = setInterval(async () => {
      await this._collectDomain(reg).catch(err => {
        console.error(`[world-state-engine] Ticker error for domain "${reg.name}":`, err);
      });
    }, reg.tickMs);
  }

  // ── Domain collection ──────────────────────────────────────────────────────

  private async _collectDomain(reg: DomainRegistration): Promise<void> {
    // Serialize ticks — skip if a collection is already in-flight for this domain
    if (reg.tickInProgress) {
      console.debug(`[world-state-engine] Domain "${reg.name}" tick skipped — previous tick still running`);
      return;
    }
    reg.tickInProgress = true;
    reg.tickCount += 1;
    const tickNum = reg.tickCount;

    const span = this.tracer.startSpan(`world_state.tick.${reg.name}`, {
      domain: reg.name,
      tickNumber: tickNum,
    });

    const startTs = Date.now();

    try {
      const rawData = await reg.collector();

      const domainData: WorldStateDomain<unknown> = {
        data: rawData,
        metadata: {
          collectedAt: Date.now(),
          domain: reg.name,
          tickNumber: tickNum,
        },
      };

      this.worldState.domains[reg.name] = domainData;
      this.worldState.timestamp = Date.now();
      this.worldState.extensions[`${reg.name}_available`] = true;

      await this._writeToRedis(reg.name, domainData, reg.tickMs).catch(err => {
        console.warn(`[world-state-engine] Redis write failed for "${reg.name}": ${(err as Error).message}`);
      });

      const durationMs = Date.now() - startTs;

      if (this.bus) {
        const domainTopic = `world.state.${reg.name}`;
        const tickCorrelationId = crypto.randomUUID();

        this.bus.publish(domainTopic, {
          id: crypto.randomUUID(),
          correlationId: tickCorrelationId,
          topic: domainTopic,
          timestamp: Date.now(),
          payload: { domain: reg.name, tickNumber: tickNum, state: this.worldState },
        });

        this.bus.publish("world.state.updated", {
          id: crypto.randomUUID(),
          correlationId: tickCorrelationId,
          topic: "world.state.updated",
          timestamp: Date.now(),
          payload: this.worldState,
        });
      }

      span.end({ domain: reg.name, tickNumber: tickNum, durationMs, success: true });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[world-state-engine] Domain "${reg.name}" failed (tick ${tickNum}): ${errorMsg}`);

      this.worldState.extensions[`${reg.name}_available`] = false;

      const existing = this.worldState.domains[reg.name];
      if (existing) {
        existing.metadata.failed = true;
        existing.metadata.errorMessage = errorMsg;
      }

      span.end({ domain: reg.name, tickNumber: tickNum, success: false, error: errorMsg });
    } finally {
      reg.tickInProgress = false;
    }
  }

  // ── Initialization ─────────────────────────────────────────────────────────

  private _initRedis(): void {
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

    // @ts-ignore — ioredis is an optional peer dependency
    import("ioredis")
      .then(({ default: Redis }) => {
        const client = new Redis(redisUrl, { lazyConnect: true, enableOfflineQueue: false });
        return client.connect().then(() => {
          this.redis = {
            set: (key, value, opts) =>
              opts?.ex ? client.setex(key, opts.ex, value) : client.set(key, value),
            get: (key) => client.get(key),
            quit: () => client.quit(),
          };
          console.log(`[world-state-engine] Redis connected: ${redisUrl}`);
        }).catch((err: Error) => {
          console.warn(`[world-state-engine] Redis connection failed — using in-memory: ${err.message}`);
          client.disconnect();
        });
      })
      .catch(() => {
        console.warn("[world-state-engine] ioredis not available — using in-memory fallback");
      });
  }

  private _initLangfuse(): void {
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const baseUrl = process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";

    if (!secretKey || !publicKey) {
      console.warn("[world-state-engine] Langfuse keys not set — tracing disabled");
      return;
    }

    // @ts-ignore — langfuse is an optional peer dependency
    import("langfuse")
      .then(({ Langfuse }) => {
        const langfuse = new Langfuse({ secretKey, publicKey, baseUrl });
        this.tracer = {
          startSpan: (name, data) => {
            const trace = langfuse.trace({ name, input: data });
            const span = trace.span({ name });
            return { end: (endData) => { span.end({ output: endData }); } };
          },
          flush: () => (langfuse as { flushAsync?: () => Promise<void> }).flushAsync?.() ?? Promise.resolve(),
        };
        console.log("[world-state-engine] Langfuse tracing initialized");
      })
      .catch(() => {
        console.warn("[world-state-engine] langfuse not available — tracing disabled");
      });
  }

  private _initKnowledgeDb(): void {
    try {
      const dir = dirname(this.knowledgeDbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      this.db = new Database(this.knowledgeDbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS world_state_snapshots (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          version     INTEGER NOT NULL,
          created_at  INTEGER NOT NULL,
          snapshot    TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ws_created_at ON world_state_snapshots(created_at);
      `);

      const latest = this.db
        .query<{ snapshot: string; version: number }, []>(
          "SELECT snapshot, version FROM world_state_snapshots ORDER BY created_at DESC LIMIT 1",
        )
        .get();

      if (latest) {
        try {
          const restored = JSON.parse(latest.snapshot) as WorldState;
          this.worldState = restored;
          this.worldState.snapshotVersion = latest.version;
          console.log(`[world-state-engine] Restored snapshot v${latest.version} from knowledge.db`);
        } catch {
          console.warn("[world-state-engine] Could not parse stored snapshot — starting fresh");
        }
      }

      console.log(`[world-state-engine] knowledge.db ready: ${this.knowledgeDbPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[world-state-engine] knowledge.db init failed: ${msg}`);
      this._emitDbError(`knowledge.db initialization failed: ${msg}`);
    }
  }

  // ── Redis write ────────────────────────────────────────────────────────────

  private async _writeToRedis(
    domain: string,
    data: WorldStateDomain<unknown>,
    tickMs: number,
  ): Promise<void> {
    const ttlSeconds = Math.ceil((tickMs / 1000) * 2);
    await this.redis.set(
      `worldstate:${domain}:${data.metadata.collectedAt}`,
      JSON.stringify(data),
      { ex: ttlSeconds },
    );
    await this.redis.set(
      `worldstate:${domain}:latest`,
      JSON.stringify(data),
      { ex: ttlSeconds },
    );
  }

  // ── Bus tool handler ───────────────────────────────────────────────────────

  private async _handleGetWorldState(msg: BusMessage): Promise<void> {
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const domain = typeof payload.domain === "string" ? payload.domain : undefined;
    const maxAgeMs = typeof payload.maxAgeMs === "number" ? payload.maxAgeMs : undefined;

    const result = this.getWorldState({ domain, maxAgeMs });
    const replyTopic = msg.reply?.topic;
    if (!replyTopic) return;

    this.bus?.publish(replyTopic, {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: replyTopic,
      timestamp: Date.now(),
      payload: result !== null
        ? { success: true, data: result }
        : { success: false, error: domain ? `No data for domain "${domain}"` : "World state not yet collected" },
    });
  }

  private _persistSnapshot(): void {
    this.writeSnapshot();
  }

  private _emitDbError(message: string): void {
    if (!this.bus) return;
    const topic = "event.world_state.db_error";
    this.bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic,
      timestamp: Date.now(),
      payload: { error: message },
    });
  }
}

// ── HTTP domain collector factory ─────────────────────────────────────────────

/**
 * Creates a DomainCollector that fetches domain state from an HTTP endpoint.
 *
 * If the response is wrapped in `{ success, data }` (standard workstacean API
 * envelope), the collector unwraps it so callers see the inner payload directly.
 * This prevents double-wrapping when the engine stores the result as
 * `WorldStateDomain.data`.
 */
export function createHttpCollector(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): DomainCollector {
  const http = new HttpClient({
    timeoutMs: opts.timeoutMs ?? 10_000,
    headers: opts.headers,
  });
  return () => http.get(url, { unwrapEnvelope: true });
}

// ── MCP tool factory ──────────────────────────────────────────────────────────

export function createGetWorldStateTool(engine: WorldStateEngine): MCPTool {
  return {
    name: "get_world_state",
    description:
      "Get the current world state snapshot. Optionally filter by domain name " +
      "and set maxAgeMs to enforce a staleness limit.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Optional: return only this domain's data (e.g. 'board', 'ci', 'agent_health')",
        },
        maxAgeMs: {
          type: "number",
          description: "Optional: reject data older than this many milliseconds (default: 60000)",
        },
      },
    },
    handler: async (input: Record<string, unknown>) => {
      const domain = typeof input.domain === "string" ? input.domain : undefined;
      const maxAgeMs = typeof input.maxAgeMs === "number" ? input.maxAgeMs : undefined;
      const result = engine.getWorldState({ domain, maxAgeMs });
      if (result === null) {
        return { error: domain ? `No data for domain "${domain}"` : "World state not yet collected" };
      }
      return { success: true, data: result };
    },
  };
}
