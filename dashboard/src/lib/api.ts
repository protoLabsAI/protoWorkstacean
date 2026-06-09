// Typed fetch wrapper for all /api/* endpoints.
// All requests go through the event-viewer proxy at the same origin (:8080).
//
// Features:
//  - Automatic unwrap of { success, data } envelopes
//  - In-memory session cache with TTL per endpoint
//  - Stale-while-revalidate: components get cached data instantly, fresh in background
//  - invalidate() to force refresh
//
// Scope: the debug/observability panes are read-only (see
// docs/architecture/flow-dashboard.md). The ONE exception is the
// "Control-plane writes" section at the bottom — the Console surface
// (ADR-0004 P3): admin-key-gated mutations of the fleet. Everything else is a
// live read-only backend route.

const API_BASE = "";
const DEFAULT_TTL = 30_000;

interface CacheEntry {
  data: unknown;
  expiry: number;
}

const cache = new Map<string, CacheEntry>();

function hasEnvelope(obj: unknown): obj is { success: boolean; data: unknown } {
  return (
    !!obj &&
    typeof obj === "object" &&
    "success" in obj &&
    "data" in (obj as Record<string, unknown>)
  );
}

async function apiFetch<T>(
  path: string,
  opts: { ttl?: number; force?: boolean } = {},
): Promise<T> {
  const { ttl = DEFAULT_TTL, force = false } = opts;
  const cacheKey = `GET:${path}`;

  if (!force) {
    const cached = cache.get(cacheKey);
    if (cached && cached.expiry > Date.now()) {
      return cached.data as T;
    }
  }

  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    throw new Error(`API ${path} failed: ${res.status} ${res.statusText}`);
  }

  const raw = await res.json();
  const unwrapped = hasEnvelope(raw) ? raw.data : raw;

  cache.set(cacheKey, { data: unwrapped, expiry: Date.now() + ttl });
  return unwrapped as T;
}

/** Invalidate one or all cached endpoints. */
export function invalidate(path?: string): void {
  if (!path) {
    cache.clear();
    return;
  }
  cache.delete(`GET:${path}`);
}

/** Read cache without network. Returns undefined if not cached. */
export function peek<T>(path: string): T | undefined {
  const entry = cache.get(`GET:${path}`);
  if (!entry || entry.expiry <= Date.now()) return undefined;
  return entry.data as T;
}

// ── Live backend APIs (proxied through the event-viewer to the main server) ──
// TTL tuned to each endpoint's refresh cadence.

export const getAgentsRuntime = (force = false) =>
  apiFetch<AgentsRuntimeResponse>("/api/agents/runtime", { ttl: 30_000, force });

/** A persisted dispatch record (one per correlationId) — the orchestration canvas's execution log. */
export interface FlowRecord {
  id: string;
  type: string | null;
  status: string | null;
  stage: string | null;
  createdAt: number | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  skill: string | null;
  executorType: string | null;
  targetAgent: string | null;
  errorPreview: string | null;
  updatedAt: number;
}

export const getFlows = (force = false) =>
  apiFetch<{ count: number; flows: FlowRecord[] }>("/api/flows", { ttl: 10_000, force });

export const getCiHealth = (force = false) =>
  apiFetch<CiHealthResponse>("/api/ci-health", { ttl: 300_000, force });

export const getPrPipeline = (force = false) =>
  apiFetch<PrPipelineResponse>("/api/pr-pipeline", { ttl: 120_000, force });

export const getSecuritySummary = (force = false) =>
  apiFetch<SecuritySummaryResponse>("/api/security-summary", { ttl: 60_000, force });

export const getHitlPending = () =>
  apiFetch<{ data: unknown[] }>("/api/hitl/pending", { ttl: 30_000 });

export const getCeremonies = () =>
  apiFetch<{ data: unknown[] }>("/api/ceremonies", { ttl: 60_000 });

/** GET /api/control-plane/state — unified control-plane read: fleet + durable-backed health. */
export const getControlPlaneState = (force = false) =>
  apiFetch<ControlPlaneState>("/api/control-plane/state", { ttl: 15_000, force });

// ── Response types (match actual API shapes after envelope unwrap) ─

/** GET /api/agents/runtime — the live fleet: every registered executor grouped by agent. */
export interface AgentsRuntimeResponse {
  agents: Array<{
    name: string;
    type: string;
    skills: string[];
    /** A2A agent known from yaml but not yet discovered (no skills registered). */
    pendingDiscovery?: boolean;
    /** A2A only: endpoint host[:port] (e.g. "roxy:7870"). */
    host?: string;
  }>;
}

/** Per-agent 24h health rollup (subset of the backend FleetHealthSnapshot). */
export interface AgentHealthMetrics {
  agentName: string;
  successRate: number;
  totalOutcomes: number;
  failureRate1h: number;
}

/** A registered MCP server (ADR-0005 P4) — registry view. */
export interface McpServerSummary {
  name: string;
  trust: "builtin" | "trusted" | "community";
  transport: "stdio" | "sse";
  enabled: boolean;
  grants: Array<"network" | "secrets" | "filesystem">;
  description?: string;
}

/** GET /api/control-plane/state — unified read: live fleet + (durably-backed) health + MCP servers. */
export interface ControlPlaneState {
  agents: AgentsRuntimeResponse["agents"];
  mcpServers: McpServerSummary[];
  health: {
    agents: AgentHealthMetrics[];
    windowHours: 24;
    maxFailureRate1h: number;
    totalCostUsd1d: number;
    collectedAt: number;
  } | null;
  collectedAt: number;
}

/** Result of probing an MCP server's tools (POST /api/mcp-servers/test). */
export interface McpProbeResult {
  reachable: boolean;
  tools?: Array<{ name: string; description?: string }>;
  latencyMs?: number;
  error?: string;
}

export interface CiHealthResponse {
  successRate: number;
  totalRuns: number;
  failedRuns: number;
  projects: Array<{
    repo: string;
    successRate: number;
    totalRuns: number;
    failedRuns: number;
    latestConclusion: string | null;
  }>;
}

export interface PrPipelineResponse {
  totalOpen: number;
  conflicting: number;
  stale: number;
  failingCi: number;
  changesRequested: number;
  readyToMerge: number;
  prs: Array<{
    repo: string;
    number: number;
    title: string;
    headSha: string;
    author: string;
    baseRef: string;
    mergeable: "clean" | "dirty" | "blocked" | "unknown";
    ciStatus: "pass" | "fail" | "pending" | "none";
    reviewState: "approved" | "changes_requested" | "pending" | "none";
    isDraft: boolean;
    readyToMerge: boolean;
    updatedAt: string;
    stale: boolean;
    labels: string[];
  }>;
}

export interface SecuritySummaryResponse {
  openCount: number;
  criticalCount: number;
  incidents: Array<{ id: string; title: string; severity: string; status: string }>;
}

// ── Control-plane writes (Console / ADR-0004 P3 — admin-key gated) ──────────
// The fleet's write surface. Unlike the read getters, these are NOT cached and
// return the raw { status, body } so the Console can show 201/409/400/401 etc.
// The admin key is held in localStorage and sent as X-API-Key.

const ADMIN_KEY_LS = "workstacean.adminKey";
export function getAdminKey(): string {
  return (typeof localStorage !== "undefined" && localStorage.getItem(ADMIN_KEY_LS)) || "";
}
export function setAdminKey(key: string): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(ADMIN_KEY_LS, key);
}

export interface WriteResult {
  status: number;
  ok: boolean;
  body: Record<string, unknown> | null;
}

async function adminFetch(path: string, method: string, body?: unknown): Promise<WriteResult> {
  const key = getAdminKey();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-api-key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: Record<string, unknown> | null = null;
  try { parsed = (await res.json()) as Record<string, unknown>; } catch { /* empty body */ }
  return { status: res.status, ok: res.ok, body: parsed };
}

/** Validate an agent definition without persisting it. */
export const testAgent = (def: unknown) => adminFetch("/api/agents/test", "POST", def);
/** Create a new in-process agent (→ hot-reload registers it in ~5s). */
export const createAgent = (def: unknown) => adminFetch("/api/agents", "POST", def);
/** Update an existing agent by name. */
export const updateAgent = (name: string, def: unknown) =>
  adminFetch(`/api/agents/${encodeURIComponent(name)}`, "PUT", def);
/** Remove an agent by name (→ unregistered in ~5s). */
export const deleteAgent = (name: string) =>
  adminFetch(`/api/agents/${encodeURIComponent(name)}`, "DELETE");
/** Read one agent's full definition (to pre-fill the edit form). */
export const getAgentDef = (name: string) =>
  adminFetch(`/api/agents/${encodeURIComponent(name)}`, "GET");
/** Probe an A2A agent's card for reachability + skills (capability discovery). */
export const probeAgentCard = (url: string) =>
  adminFetch("/api/a2a/probe", "POST", { url });
/** Register a remote A2A agent (persisted to agents.d/; live via SkillBroker). */
export const createA2aEndpoint = (entry: unknown) =>
  adminFetch("/api/a2a-endpoints", "POST", entry);
/** Remove a control-plane-managed A2A agent. */
export const deleteA2aEndpoint = (name: string) =>
  adminFetch(`/api/a2a-endpoints/${encodeURIComponent(name)}`, "DELETE");

// ── MCP servers (ADR-0005 P4) ───────────────────────────────────────────────
/** Probe a candidate MCP server for reachability + tools (test-before-save). */
export const probeMcpServer = (def: unknown) => adminFetch("/api/mcp-servers/test", "POST", def);
/** Register an MCP server (persisted to mcp-servers.d/; tools connect live when enabled). */
export const createMcpServer = (def: unknown) => adminFetch("/api/mcp-servers", "POST", def);
/** Read one MCP server's full stored def (to flip enabled / pre-fill an edit). */
export const getMcpServerDef = (name: string) =>
  adminFetch(`/api/mcp-servers/${encodeURIComponent(name)}`, "GET");
/** Update an MCP server (e.g. toggle enabled, change grants). */
export const updateMcpServer = (name: string, def: unknown) =>
  adminFetch(`/api/mcp-servers/${encodeURIComponent(name)}`, "PUT", def);
/** Remove an MCP server (→ disconnected + unregistered live). */
export const deleteMcpServer = (name: string) =>
  adminFetch(`/api/mcp-servers/${encodeURIComponent(name)}`, "DELETE");

// ── Routes (wiring) — ADR-0008 P2 ───────────────────────────────────────────
/** A declarative wiring route: "when when.topic fires, dispatch then.skill (to then.agent)." */
export interface RouteSummary {
  name: string;
  description?: string;
  when: { topic: string };
  then: { skill: string; agent?: string };
  enabled?: boolean;
}
/** GET /api/routes — live wiring routes, rendered as canvas edges. */
export const getRoutes = (force = false) =>
  apiFetch<{ routes: RouteSummary[] }>("/api/routes", { ttl: 10_000, force });
/** Author a route (persisted to routes.d/; live via hot-reload). */
export const createRoute = (def: unknown) => adminFetch("/api/routes", "POST", def);
/** Remove a route by name (→ unsubscribed live). */
export const deleteRoute = (name: string) =>
  adminFetch(`/api/routes/${encodeURIComponent(name)}`, "DELETE");
