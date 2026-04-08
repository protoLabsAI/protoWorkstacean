/**
 * WorldStateCollectorPlugin — multi-rate world state collection.
 *
 * Per-domain tick rates: services=30s, board=60s, CI=300s (5min), portfolio=900s (15min)
 *
 * Features:
 *   - Per-domain independent tick schedulers
 *   - Redis fast-path write layer (in-memory fallback when Redis unavailable)
 *   - knowledge.db persistent SQLite snapshots
 *   - get_world_state MCP tool exposed via event bus
 *   - Langfuse tracing for every world tick (disabled gracefully when unavailable)
 *
 * Inbound topics:
 *   tool.world_state.get       — bus-based world state query
 *   mcp.tool.get_world_state   — MCP tool invocation
 *
 * Outbound topics:
 *   event.world_state.db_error — emitted when knowledge.db write fails
 */

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { PlaneClient } from "../plane-client.ts";
import type { Plugin, EventBus, BusMessage } from "../types.ts";
import type {
  WorldState,
  WorldStateDomain,
  ServiceState,
  ServiceInstance,
  BoardState,
  CIState,
  PortfolioState,
  PortfolioProject,
  WorldStateSnapshot,
  AgentHealthState,
  AgentHealthEntry,
  SecurityState,
  SecurityIncident,
} from "../types/world-state.ts";

// ── Tick rates (ms) ───────────────────────────────────────────────────────────
// Per-domain tick rates: services=30s, board=60s, CI=300s (5min), portfolio=900s (15min)

const TICK_RATES = {
  services: 30_000,      // 30s
  board: 60_000,         // 60s
  ci: 300_000,           // 5min (CI=300s)
  portfolio: 900_000,    // 15min (portfolio=900s)
  agent_health: 60_000,  // 60s
  security: 30_000,      // 30s — incidents must surface fast
} as const;

type DomainName = keyof typeof TICK_RATES;

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

// ── Issue type classification helper ─────────────────────────────────────────

/**
 * Classify a Plane work item as feature/defect/risk/debt based on its label names.
 * Defaults to "feature" when no labels match.
 */
function _classifyIssueType(
  labelIds: string[],
  labelMap: Map<string, string>,
): "feature" | "defect" | "risk" | "debt" {
  const names = labelIds.map(id => labelMap.get(id)?.toLowerCase() ?? "").filter(Boolean);
  if (names.some(n => /bug|defect|fix/.test(n))) return "defect";
  if (names.some(n => /risk|security|vuln/.test(n))) return "risk";
  if (names.some(n => /debt|tech.?debt|refactor|cleanup/.test(n))) return "debt";
  return "feature";
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class WorldStateCollectorPlugin implements Plugin {
  readonly name = "world-state-collector";
  readonly description =
    "Multi-rate world state collection with Redis fast-path, knowledge.db snapshots, and Langfuse tracing";
  readonly capabilities = ["world_state", "get_world_state"];

  private bus?: EventBus;
  private timers: Map<DomainName, ReturnType<typeof setInterval>> = new Map();
  private tickCounters: Map<DomainName, number> = new Map();
  private subscriptionIds: string[] = [];

  private redis: RedisClient = new InMemoryRedis();
  private tracer: Tracer = new NoopTracer();
  private db: Database | null = null;

  // Current world state (in-memory)
  private worldState: WorldState = {
    timestamp: Date.now(),
    domains: {},
    extensions: {},
    snapshotVersion: 0,
  };

  private readonly knowledgeDbPath: string;
  private readonly snapshotIntervalMs: number;
  private readonly workspaceDir: string;
  private snapshotTimer?: ReturnType<typeof setInterval>;

  constructor(options?: { knowledgeDbPath?: string; snapshotIntervalMs?: number; workspaceDir?: string }) {
    this.knowledgeDbPath = resolve(options?.knowledgeDbPath ?? "data/knowledge.db");
    this.snapshotIntervalMs = options?.snapshotIntervalMs ?? 300_000; // default 5min
    this.workspaceDir = resolve(options?.workspaceDir ?? process.env.WORKSPACE_DIR ?? "workspace");
  }

  install(bus: EventBus): void {
    this.bus = bus;

    // Initialize dependencies (all fail gracefully)
    this._initRedis();
    this._initLangfuse();
    this._initKnowledgeDb();

    // Subscribe to get_world_state tool requests via event bus
    const subId = bus.subscribe("tool.world_state.get", this.name, async (msg: BusMessage) => {
      await this._handleGetWorldState(msg);
    });
    this.subscriptionIds.push(subId);

    // Also accept MCP tool invocation topic (mcp.tool.get_world_state)
    const mcpSubId = bus.subscribe("mcp.tool.get_world_state", this.name, async (msg: BusMessage) => {
      await this._handleGetWorldState(msg);
    });
    this.subscriptionIds.push(mcpSubId);

    // Start per-domain tick schedulers
    // Per-domain tick rates: services=30s, board=60s, CI=300s (5min), portfolio=900s (15min), agent_health=60s
    this._startDomainTicker("services", TICK_RATES.services);
    this._startDomainTicker("board", TICK_RATES.board);
    this._startDomainTicker("ci", TICK_RATES.ci);
    this._startDomainTicker("portfolio", TICK_RATES.portfolio);
    this._startDomainTicker("agent_health", TICK_RATES.agent_health);
    this._startDomainTicker("security", TICK_RATES.security);

    // Periodic knowledge.db snapshot
    this.snapshotTimer = setInterval(() => {
      this._persistSnapshot().catch(err => {
        console.error("[world-state-collector] Periodic snapshot failed:", err);
      });
    }, this.snapshotIntervalMs);

    // Trigger initial collection for all domains immediately
    void this._collectDomain("services");
    void this._collectDomain("board");
    void this._collectDomain("ci");
    void this._collectDomain("portfolio");
    void this._collectDomain("agent_health");
    void this._collectDomain("security");

    // Re-collect security immediately when an incident is reported via the bus
    const secSubId = bus.subscribe("security.incident.reported", this.name, () => {
      void this._collectDomain("security");
    });
    this.subscriptionIds.push(secSubId);

    console.log(
      "[world-state-collector] Plugin installed — " +
      "tickers: services=30s, board=60s, CI=300s, portfolio=900s, agent_health=60s, security=30s",
    );
  }

  uninstall(): void {
    // Stop all domain timers
    for (const [, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();

    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = undefined;
    }

    // Unsubscribe from bus
    if (this.bus) {
      for (const id of this.subscriptionIds) {
        this.bus.unsubscribe(id);
      }
    }
    this.subscriptionIds = [];

    // Flush langfuse traces before exit
    this.tracer.flush().catch(() => {});

    // Close Redis connection
    this.redis.quit().catch(() => {});

    // Close SQLite
    if (this.db) {
      this.db.close();
      this.db = null;
    }

    console.log("[world-state-collector] Plugin uninstalled");
  }

  // ── Public tool API (MCP tool) ─────────────────────────────────────────────

  /**
   * get_world_state — returns current world state snapshot.
   * Optionally filters by domain and enforces a maxAgeMs staleness guard.
   */
  getWorldState(options?: {
    domain?: DomainName;
    maxAgeMs?: number;
  }): WorldState | WorldStateDomain<unknown> | null {
    const maxAge = options?.maxAgeMs ?? 60_000;
    const now = Date.now();

    if (options?.domain) {
      const domainData = this.worldState.domains[options.domain];
      if (!domainData) return null;
      const age = now - domainData.metadata.collectedAt;
      if (age > maxAge) {
        console.warn(
          `[world-state-collector] Domain "${options.domain}" data is stale (age: ${age}ms, max: ${maxAge}ms)`,
        );
      }
      return domainData;
    }

    return this.worldState;
  }

  /**
   * Returns the get_world_state MCP tool descriptor bound to this plugin instance.
   */
  getMCPTool(): MCPTool {
    return createGetWorldStateTool(this);
  }

  // ── Initialization ─────────────────────────────────────────────────────────

  private _initRedis(): void {
    const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";

    // Attempt dynamic import of ioredis; fall back to in-memory on failure
    // @ts-ignore — ioredis is an optional peer dependency; graceful fallback handles absence
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
          console.log(`[world-state-collector] Redis connected: ${redisUrl}`);
        }).catch((err: Error) => {
          console.warn(
            `[world-state-collector] Redis connection failed — using in-memory cache: ${err.message}`,
          );
          client.disconnect();
          // In-memory fallback already set; Redis writes will be retried on next tick
        });
      })
      .catch(() => {
        console.warn(
          "[world-state-collector] ioredis not available — using in-memory cache fallback",
        );
      });
  }

  private _initLangfuse(): void {
    const secretKey = process.env.LANGFUSE_SECRET_KEY;
    const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const baseUrl = process.env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com";

    if (!secretKey || !publicKey) {
      console.warn("[world-state-collector] Langfuse keys not set — tracing disabled");
      return;
    }

    // Dynamic import; no-op tracer remains active if langfuse is unavailable
    // @ts-ignore — langfuse is an optional peer dependency; graceful fallback handles absence
    import("langfuse")
      .then(({ Langfuse }) => {
        const langfuse = new Langfuse({ secretKey, publicKey, baseUrl });
        this.tracer = {
          startSpan: (name, data) => {
            const trace = langfuse.trace({ name, input: data });
            const span = trace.span({ name });
            return {
              end: (endData) => {
                span.end({ output: endData });
              },
            };
          },
          flush: () => (langfuse as { flushAsync?: () => Promise<void> }).flushAsync?.() ?? Promise.resolve(),
        };
        console.log("[world-state-collector] Langfuse tracing initialized");
      })
      .catch(() => {
        console.warn("[world-state-collector] langfuse package not available — tracing disabled");
      });
  }

  private _initKnowledgeDb(): void {
    try {
      const dir = dirname(this.knowledgeDbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

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

      // Restore latest snapshot from knowledge.db on startup
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
          console.log(
            `[world-state-collector] Restored world state snapshot v${latest.version} from knowledge.db`,
          );
        } catch {
          console.warn(
            "[world-state-collector] Could not parse stored snapshot — starting fresh",
          );
        }
      }

      console.log(`[world-state-collector] knowledge.db ready: ${this.knowledgeDbPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[world-state-collector] knowledge.db init failed: ${msg}`);
      this._emitDbError(`knowledge.db initialization failed: ${msg}`);
      // Continue without DB — Redis/in-memory cache still available
    }
  }

  // ── Tick scheduling ────────────────────────────────────────────────────────

  private _startDomainTicker(domain: DomainName, intervalMs: number): void {
    this.tickCounters.set(domain, 0);
    const timer = setInterval(async () => {
      await this._collectDomain(domain).catch(err => {
        console.error(`[world-state-collector] Ticker error for domain "${domain}":`, err);
      });
    }, intervalMs);
    this.timers.set(domain, timer);
  }

  // ── Domain collection orchestrator ────────────────────────────────────────

  private async _collectDomain(domain: DomainName): Promise<void> {
    const tickNum = (this.tickCounters.get(domain) ?? 0) + 1;
    this.tickCounters.set(domain, tickNum);

    const span = this.tracer.startSpan(`world_state.tick.${domain}`, {
      domain,
      tickNumber: tickNum,
      startedAt: new Date().toISOString(),
    });

    const startTs = Date.now();

    try {
      let domainData: WorldStateDomain<unknown>;

      switch (domain) {
        case "services":
          domainData = await this._collectServices(tickNum);
          break;
        case "board":
          domainData = await this._collectBoard(tickNum);
          break;
        case "ci":
          domainData = await this._collectCI(tickNum);
          break;
        case "portfolio":
          domainData = await this._collectPortfolio(tickNum);
          break;
        case "agent_health":
          domainData = await this._collectAgentHealth(tickNum);
          break;
        case "security":
          domainData = await this._collectSecurity(tickNum);
          break;
        default:
          throw new Error(`Unknown domain: ${String(domain)}`);
      }

      // Update in-memory world state
      (this.worldState.domains as Record<string, unknown>)[domain] = domainData;
      this.worldState.timestamp = Date.now();

      // Redis fast-path write
      const redisWriteStart = Date.now();
      await this._writeToRedis(domain, domainData).catch(err => {
        console.warn(
          `[world-state-collector] Redis write failed for "${domain}": ${(err as Error).message}`,
        );
      });
      const redisLatencyMs = Date.now() - redisWriteStart;
      const durationMs = Date.now() - startTs;

      // Publish to event bus so GoalEvaluatorPlugin can evaluate goals (world.state.# wildcard)
      if (this.bus) {
        const domainTopic = `world.state.${domain}`;
        this.bus.publish(domainTopic, {
          id: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          topic: domainTopic,
          timestamp: Date.now(),
          payload: { domain, tickNumber: tickNum, state: this.worldState },
        });
        // Also publish world.state.updated with full WorldState so ActionDispatcherPlugin stays in sync
        this.bus.publish("world.state.updated", {
          id: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          topic: "world.state.updated",
          timestamp: Date.now(),
          payload: this.worldState,
        });
      }

      span.end({
        domain,
        tickNumber: tickNum,
        durationMs,
        redisWriteLatencyMs: redisLatencyMs,
        statePropertiesCount: Object.keys(domainData.data as object ?? {}).length,
        success: true,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `[world-state-collector] Domain "${domain}" failed (tick ${tickNum}): ${errorMsg}`,
      );

      // Mark domain as failed in metadata but preserve old data
      const existing = (this.worldState.domains as Record<string, WorldStateDomain<unknown> | undefined>)[domain];
      if (existing) {
        existing.metadata.failed = true;
        existing.metadata.errorMessage = errorMsg;
      }

      span.end({ domain, tickNumber: tickNum, success: false, error: errorMsg });
      // Do not re-throw — other domains must continue
    }
  }

  // ── Domain-specific collectors ─────────────────────────────────────────────

  private async _collectServices(tickNum: number): Promise<WorldStateDomain<ServiceState>> {
    const instances = await this._fetchServiceHealth();
    const data: ServiceState = {
      instances,
      totalHealthy: instances.filter(s => s.status === "healthy").length,
      totalDegraded: instances.filter(s => s.status === "degraded").length,
      totalDown: instances.filter(s => s.status === "down").length,
    };
    return {
      data,
      metadata: { collectedAt: Date.now(), domain: "services", tickNumber: tickNum },
    };
  }

  private async _collectBoard(tickNum: number): Promise<WorldStateDomain<BoardState>> {
    const workspaceSlug = process.env.PLANE_WORKSPACE_SLUG ?? "protolabsai";
    const apiKey = process.env.PLANE_API_KEY ?? "";
    const baseUrl = process.env.PLANE_BASE_URL ?? "http://ava:3002";

    // Without an API key we can't fetch — return zeroed state without throwing
    if (!apiKey) {
      console.warn("[world-state-collector] PLANE_API_KEY not set — board domain will be empty");
      const data: BoardState = {
        projectSlug: workspaceSlug,
        openIssues: 0, inProgress: 0, done: 0, issues: [],
        efficiency: 0,
        distribution: { feature: 0, defect: 0, risk: 0, debt: 0 },
      };
      return { data, metadata: { collectedAt: Date.now(), domain: "board", tickNumber: tickNum } };
    }

    const client = new PlaneClient(baseUrl, workspaceSlug, apiKey);
    const projects = await client.listProjects();

    let totalOpen = 0, totalInProgress = 0, totalDone = 0;
    let totalFeature = 0, totalDefect = 0, totalRisk = 0, totalDebt = 0;
    const allIssues: BoardState["issues"] = [];

    for (const project of projects) {
      const [stateGroups, labelMap, issues] = await Promise.all([
        client.fetchStateGroups(project.id),
        client.fetchLabels(project.id),
        client.listIssues(project.id, { pageSize: 100, maxIssues: 500 }),
      ]);

      for (const issue of issues) {
        const group = stateGroups.get(issue.state) ?? "unstarted";

        if (group === "started") {
          totalInProgress++;
        } else if (group === "completed") {
          totalDone++;
        } else if (group !== "cancelled") {
          totalOpen++; // backlog + unstarted
        }

        const issueType = _classifyIssueType(issue.label_ids, labelMap);
        if (issueType === "defect") totalDefect++;
        else if (issueType === "risk") totalRisk++;
        else if (issueType === "debt") totalDebt++;
        else totalFeature++;

        allIssues.push({
          id: issue.id,
          title: issue.name,
          status: group,
          priority: issue.priority,
          assignee: issue.assignees?.[0],
          updatedAt: issue.updated_at,
        });
      }
    }

    const waitingCount = totalOpen + totalInProgress;
    const efficiency = waitingCount > 0 ? totalInProgress / waitingCount : 0;

    const typeTotal = totalFeature + totalDefect + totalRisk + totalDebt || 1;
    const distribution = {
      feature: totalFeature / typeTotal,
      defect: totalDefect / typeTotal,
      risk: totalRisk / typeTotal,
      debt: totalDebt / typeTotal,
    };

    const data: BoardState = {
      projectSlug: workspaceSlug,
      openIssues: totalOpen,
      inProgress: totalInProgress,
      done: totalDone,
      issues: allIssues.slice(0, 100),
      efficiency,
      distribution,
    };

    return { data, metadata: { collectedAt: Date.now(), domain: "board", tickNumber: tickNum } };
  }

  private async _collectCI(tickNum: number): Promise<WorldStateDomain<CIState>> {
    const token = process.env.GITHUB_TOKEN;

    // Derive repo list from projects.yaml
    const repos = this._readReposFromPortfolio();
    if (repos.length === 0 && process.env.GITHUB_REPOSITORY) {
      repos.push(process.env.GITHUB_REPOSITORY);
    }

    if (!token || repos.length === 0) {
      const data: CIState = { repository: repos[0] ?? "", runs: [], successRate: undefined };
      return { data, metadata: { collectedAt: Date.now(), domain: "ci", tickNumber: tickNum } };
    }

    const allRuns: CIState["runs"] = [];

    for (const repo of repos.slice(0, 5)) {
      try {
        const resp = await fetch(
          `https://api.github.com/repos/${repo}/actions/runs?per_page=10`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "User-Agent": "protoWorkstacean",
            },
            signal: AbortSignal.timeout(8_000),
          },
        );
        if (!resp.ok) continue;

        const body = (await resp.json()) as {
          workflow_runs?: Array<{
            id: number;
            name: string;
            status: string;
            conclusion: string | null;
            head_branch: string;
            run_started_at?: string;
            updated_at?: string;
            html_url: string;
          }>;
        };

        for (const run of body.workflow_runs ?? []) {
          allRuns.push({
            id: String(run.id),
            name: `${repo} / ${run.name}`,
            status: run.conclusion ?? run.status,
            branch: run.head_branch,
            startedAt: run.run_started_at,
            finishedAt: run.updated_at,
            url: run.html_url,
          });
        }
      } catch {
        // Skip this repo; continue with others
      }
    }

    const completed = allRuns.filter(r => r.status === "success" || r.status === "failure");
    const successRate = completed.length > 0
      ? completed.filter(r => r.status === "success").length / completed.length
      : undefined;

    const data: CIState = {
      repository: repos.join(", "),
      runs: allRuns.slice(0, 50),
      successRate,
    };
    return { data, metadata: { collectedAt: Date.now(), domain: "ci", tickNumber: tickNum } };
  }

  private _collectPortfolio(tickNum: number): Promise<WorldStateDomain<PortfolioState>> {
    const projectsPath = join(this.workspaceDir, "projects.yaml");
    const projects: PortfolioProject[] = [];

    if (existsSync(projectsPath)) {
      try {
        const raw = readFileSync(projectsPath, "utf8");
        const parsed = parseYaml(raw) as {
          projects?: Array<{
            slug?: string;
            title?: string;
            github?: string;
            status?: string;
            agents?: string[];
          }>;
        };

        for (const p of parsed.projects ?? []) {
          if (!p.slug) continue;
          projects.push({
            slug: p.slug,
            title: p.title ?? p.slug,
            github: p.github ?? "",
            status: (p.status ?? "active") as PortfolioProject["status"],
            agents: p.agents ?? [],
          });
        }
      } catch (err) {
        console.warn("[world-state-collector] Failed to read projects.yaml for portfolio:", err);
      }
    }

    const data: PortfolioState = {
      totalProjects: projects.length,
      activeProjects: projects.filter(p => p.status === "active").length,
      projects,
    };

    return Promise.resolve({
      data,
      metadata: { collectedAt: Date.now(), domain: "portfolio", tickNumber: tickNum },
    });
  }

  private async _collectAgentHealth(tickNum: number): Promise<WorldStateDomain<AgentHealthState>> {
    const agentsPath = join(this.workspaceDir, "agents.yaml");
    const agentDefs: Array<{ name: string; url: string }> = [];

    if (existsSync(agentsPath)) {
      try {
        const raw = readFileSync(agentsPath, "utf8");
        const parsed = parseYaml(raw) as { agents?: Array<{ name: string; url: string }> };
        for (const a of parsed.agents ?? []) {
          if (a.name && a.url) agentDefs.push({ name: a.name, url: a.url });
        }
      } catch (err) {
        console.warn("[world-state-collector] Failed to read agents.yaml for agent_health:", err);
      }
    }

    const entries: AgentHealthEntry[] = await Promise.all(
      agentDefs.map(async ({ name, url }): Promise<AgentHealthEntry> => {
        const start = Date.now();
        try {
          // Probe /health on the agent's base URL (strip /a2a suffix if present)
          const baseUrl = url.replace(/\/a2a$/, "");
          const resp = await fetch(`${baseUrl}/health`, {
            method: "GET",
            signal: AbortSignal.timeout(5_000),
          });
          const latencyMs = Date.now() - start;
          const reachable = resp.ok || resp.status === 401 || resp.status === 403;
          return { name, url, reachable, latencyMs, lastChecked: Date.now() };
        } catch (err) {
          return {
            name,
            url,
            reachable: false,
            lastChecked: Date.now(),
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    const unreachableAgents = entries.filter(e => !e.reachable).map(e => e.name);
    const data: AgentHealthState = {
      entries,
      totalReachable: entries.filter(e => e.reachable).length,
      totalUnreachable: unreachableAgents.length,
      unreachableAgents,
    };

    return {
      data,
      metadata: { collectedAt: Date.now(), domain: "agent_health", tickNumber: tickNum },
    };
  }

  private async _collectSecurity(tickNum: number): Promise<WorldStateDomain<SecurityState>> {
    const incidentsPath = join(this.workspaceDir, "incidents.yaml");
    let incidents: SecurityIncident[] = [];

    if (existsSync(incidentsPath)) {
      try {
        const raw = readFileSync(incidentsPath, "utf8");
        const parsed = parseYaml(raw) as { incidents?: SecurityIncident[] };
        incidents = parsed.incidents ?? [];
      } catch (err) {
        console.warn("[world-state-collector] Failed to read incidents.yaml:", err);
      }
    }

    const open = incidents.filter(i => i.status !== "resolved");
    const data: SecurityState = {
      incidents,
      openIncidents: open.length,
      criticalIncidents: open.filter(i => i.severity === "critical").length,
    };

    return {
      data,
      metadata: { collectedAt: Date.now(), domain: "security", tickNumber: tickNum },
    };
  }

  // ── Service health checks ─────────────────────────────────────────────────

  private async _fetchServiceHealth(): Promise<ServiceInstance[]> {
    type ServiceCheck = { name: string; url: string; headers?: Record<string, string> };

    const planeKey = process.env.PLANE_API_KEY;
    const ghToken = process.env.GITHUB_TOKEN;

    const checks: ServiceCheck[] = [
      {
        name: "plane",
        url: `${process.env.PLANE_BASE_URL ?? "http://ava:3002"}/api/v1/workspaces/${process.env.PLANE_WORKSPACE_SLUG ?? "protolabsai"}/projects/`,
        headers: planeKey ? { "X-Api-Key": planeKey } : undefined,
      },
      {
        name: "github",
        url: "https://api.github.com/rate_limit",
        headers: ghToken ? { Authorization: `Bearer ${ghToken}` } : undefined,
      },
      {
        name: "discord",
        url: "https://discord.com/api/v10/gateway",
      },
    ];

    return Promise.all(
      checks.map(async ({ name, url, headers }): Promise<ServiceInstance> => {
        const start = Date.now();
        try {
          const resp = await fetch(url, {
            method: "GET",
            headers,
            signal: AbortSignal.timeout(5_000),
          });
          const latencyMs = Date.now() - start;
          // 401/403 counts as reachable (auth issues, not outages)
          const reachable = resp.ok || resp.status === 401 || resp.status === 403;
          return {
            name,
            status: reachable ? "healthy" : "degraded",
            lastChecked: Date.now(),
            meta: { statusCode: resp.status, latencyMs },
          };
        } catch (err) {
          return {
            name,
            status: "down",
            lastChecked: Date.now(),
            meta: { error: err instanceof Error ? err.message : String(err) },
          };
        }
      }),
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Read github repo slugs from projects.yaml for CI collection. */
  private _readReposFromPortfolio(): string[] {
    const projectsPath = join(this.workspaceDir, "projects.yaml");
    if (!existsSync(projectsPath)) return [];
    try {
      const raw = readFileSync(projectsPath, "utf8");
      const parsed = parseYaml(raw) as { projects?: Array<{ github?: string }> };
      return (parsed.projects ?? []).map(p => p.github).filter((g): g is string => !!g);
    } catch {
      return [];
    }
  }

  // ── Redis fast-path write ──────────────────────────────────────────────────

  private async _writeToRedis(domain: DomainName, data: WorldStateDomain<unknown>): Promise<void> {
    const ttlSeconds = Math.ceil((TICK_RATES[domain] / 1000) * 2); // 2× tick rate for TTL
    const key = `worldstate:${domain}:${data.metadata.collectedAt}`;
    await this.redis.set(key, JSON.stringify(data), { ex: ttlSeconds });

    // Also maintain a stable "latest" key per domain
    const latestKey = `worldstate:${domain}:latest`;
    await this.redis.set(latestKey, JSON.stringify(data), { ex: ttlSeconds });
  }

  // ── knowledge.db snapshot persistence ─────────────────────────────────────

  /**
   * Serialize current world state and write it to knowledge.db.
   * On write failure: logs error, emits event, continues without blocking.
   */
  writeSnapshot(): void {
    if (!this.db) {
      console.error("[world-state-collector] knowledge.db not available — snapshot skipped");
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

      // Prune old snapshots — keep the last 50
      this.db
        .query(
          "DELETE FROM world_state_snapshots WHERE id NOT IN " +
          "(SELECT id FROM world_state_snapshots ORDER BY created_at DESC LIMIT 50)",
        )
        .run();

      console.log(`[world-state-collector] Snapshot v${snapshot.version} written to knowledge.db`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[world-state-collector] Snapshot write failed: ${msg}`);
      this._emitDbError(`Snapshot write failed: ${msg}`);
      // Do not throw — in-memory and Redis state remain available
    }
  }

  /** Alias kept for backward-compatibility with callers using `persistSnapshot`. */
  persistSnapshot(): void {
    this.writeSnapshot();
  }

  private async _persistSnapshot(): Promise<void> {
    this.writeSnapshot();
  }

  // ── Bus tool handler ───────────────────────────────────────────────────────

  private async _handleGetWorldState(msg: BusMessage): Promise<void> {
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const domain =
      typeof payload.domain === "string" ? (payload.domain as DomainName) : undefined;
    const maxAgeMs =
      typeof payload.maxAgeMs === "number" ? payload.maxAgeMs : undefined;

    const result = this.getWorldState({ domain, maxAgeMs });
    const replyTopic = msg.reply?.topic;
    if (!replyTopic) return;

    this.bus?.publish(replyTopic, {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: replyTopic,
      timestamp: Date.now(),
      payload:
        result !== null
          ? { success: true, data: result }
          : {
              success: false,
              error: domain
                ? `No data for domain "${domain}"`
                : "World state not yet collected",
            },
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

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

// ── MCP tool factory ──────────────────────────────────────────────────────────

/**
 * Returns a get_world_state MCP tool descriptor bound to a plugin instance.
 * Pass this to your MCP server registration or agent tool registry.
 */
export function createGetWorldStateTool(plugin: WorldStateCollectorPlugin): MCPTool {
  return {
    name: "get_world_state",
    description:
      "Get the current world state snapshot. Optionally filter by domain " +
      "(services | board | ci | portfolio) and set maxAgeMs to enforce a staleness limit.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          enum: ["services", "board", "ci", "portfolio"],
          description: "Optional: return only this domain's data",
        },
        maxAgeMs: {
          type: "number",
          description: "Optional: reject data older than this many milliseconds (default: 60000)",
        },
      },
    },
    handler: async (input: Record<string, unknown>) => {
      const domain =
        typeof input.domain === "string" ? (input.domain as DomainName) : undefined;
      const maxAgeMs =
        typeof input.maxAgeMs === "number" ? input.maxAgeMs : undefined;

      const result = plugin.getWorldState({ domain, maxAgeMs });
      if (result === null) {
        return {
          error: domain ? `No data for domain "${domain}"` : "World state not yet collected",
        };
      }
      return { success: true, data: result };
    },
  };
}
