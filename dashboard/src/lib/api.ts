<<<<<<< HEAD
// Typed fetch wrapper for all /api/* endpoints
// All requests go through the event-viewer proxy at the same origin (:8080)

const API_BASE = "";

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...init?.headers },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`API ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// Event-viewer local APIs (served by event-viewer plugin itself)
export const getEvents = (topic?: string, limit = 100) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (topic) params.set("topic", topic);
  return apiFetch<unknown[]>(`/api/events?${params}`);
=======
// Typed fetch wrapper for all /api/* endpoints.
// All requests go through the event-viewer proxy at the same origin (:8080).
//
// Features:
//  - Automatic unwrap of { success, data } envelopes
//  - In-memory session cache with TTL per endpoint
//  - Stale-while-revalidate: components get cached data instantly, fresh in background
//  - invalidate() to force refresh

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

// ── Event-viewer local APIs ────────────────────────────────────────
export const getEvents = (topic?: string, limit = 500) => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (topic) params.set("topic", topic);
  return apiFetch<unknown[]>(`/api/events?${params}`, { ttl: 5_000 });
>>>>>>> origin/main
};

export const getTopics = () => apiFetch<string[]>("/api/topics");
export const getConsumers = () => apiFetch<string[]>("/api/consumers");
<<<<<<< HEAD
export const getProjects = () =>
  apiFetch<{ success: boolean; data: unknown[] }>("/api/projects");
export const getAgents = () =>
  apiFetch<{ success: boolean; data: unknown[] }>("/api/agents");

// Proxied APIs from main server (:3000)
export const getWorldState = () => apiFetch<unknown>("/api/world-state");
export const getServices = () => apiFetch<unknown>("/api/services");
export const getAgentHealth = () => apiFetch<unknown>("/api/agent-health");
export const getFlowMetrics = () => apiFetch<unknown>("/api/flow-metrics");
export const getOutcomes = () => apiFetch<unknown>("/api/outcomes");
export const getCiHealth = () => apiFetch<unknown>("/api/ci-health");
export const getPrPipeline = () => apiFetch<unknown>("/api/pr-pipeline");
export const getCeremonies = () => apiFetch<unknown>("/api/ceremonies");
export const getIncidents = () => apiFetch<unknown>("/api/incidents");
export const getSecuritySummary = () =>
  apiFetch<unknown>("/api/security-summary");
export const getChannels = () => apiFetch<unknown>("/api/channels");
export const getHitlPending = () => apiFetch<unknown>("/api/hitl/pending");
=======

// ── Proxied APIs from main server (:3000) ─────────────────────────
// TTL tuned to each endpoint's refresh cadence.
export const getWorldState = (force = false) =>
  apiFetch<WorldStateResponse>("/api/world-state", { ttl: 15_000, force });

export const getServices = (force = false) =>
  apiFetch<ServicesResponse>("/api/services", { ttl: 30_000, force });

export const getAgentHealth = (force = false) =>
  apiFetch<AgentHealthResponse>("/api/agent-health", { ttl: 30_000, force });

export const getFlowMetrics = (force = false) =>
  apiFetch<FlowMetricsResponse>("/api/flow-metrics", { ttl: 30_000, force });

export const getOutcomes = (force = false) =>
  apiFetch<OutcomesResponse>("/api/outcomes", { ttl: 15_000, force });

export const getCiHealth = (force = false) =>
  apiFetch<CiHealthResponse>("/api/ci-health", { ttl: 300_000, force });

export const getPrPipeline = (force = false) =>
  apiFetch<PrPipelineResponse>("/api/pr-pipeline", { ttl: 120_000, force });

export const getBranchDrift = (force = false) =>
  apiFetch<BranchDriftResponse>("/api/branch-drift", { ttl: 600_000, force });

export const getSecuritySummary = (force = false) =>
  apiFetch<SecuritySummaryResponse>("/api/security-summary", { ttl: 60_000, force });

export const getProjects = () =>
  apiFetch<unknown[]>("/api/projects", { ttl: 60_000 });

export const getAgents = () =>
  apiFetch<unknown[]>("/api/agents", { ttl: 60_000 });

export const getGoals = () =>
  apiFetch<unknown[]>("/api/goals", { ttl: 60_000 });

export const getIncidents = () =>
  apiFetch<{ data: unknown[] }>("/api/incidents", { ttl: 60_000 });

export const getCeremonies = () =>
  apiFetch<{ data: unknown[] }>("/api/ceremonies", { ttl: 60_000 });

export const getHitlPending = () =>
  apiFetch<{ data: unknown[] }>("/api/hitl/pending", { ttl: 30_000 });

// ── Response types (match actual API shapes after envelope unwrap) ─
export interface WorldStateResponse {
  timestamp: number;
  domains: Record<string, {
    data: unknown;
    metadata: {
      collectedAt: number;
      domain: string;
      tickNumber: number;
      failed?: boolean;
      errorMessage?: string;
    };
  }>;
  extensions: Record<string, unknown>;
  snapshotVersion: number;
}

export interface ServicesResponse {
  discord: { configured: boolean; connected: boolean; bot: string | null };
  github: { configured: boolean; authType: string | null };
  plane: { configured: boolean; baseUrl: string | null };
  gateway: { configured: boolean; url: string | null };
  langfuse: { configured: boolean };
  graphiti: { configured: boolean; url: string | null };
}

export interface AgentHealthResponse {
  agentCount: number;
  agents: Record<string, { skills: string[]; executorType: string }>;
  registrationCount: number;
}

export interface FlowMetricsResponse {
  velocity?: { currentPeriodCount: number; rollingAverage: number; trend: number };
  leadTime?: { p50Ms: number; p95Ms: number };
  efficiency?: { ratio: number; target: number; healthy: boolean };
  load?: { totalWIP: number };
  distribution?: { ratios: Record<string, number>; balanced: boolean };
  bottleneck?: { primaryBottleneck: string | null; hasBottleneck: boolean };
}

export interface OutcomesResponse {
  summary: { success: number; failure: number; timeout: number; total: number };
  recent: Array<{
    correlationId: string;
    actionId: string;
    goalId: string;
    status: string;
    startedAt: number;
    completedAt: number;
    durationMs: number;
  }>;
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

export interface BranchDriftResponse {
  maxDrift: number;
  projects: Array<{
    repo: string;
    devToStaging: number | null;
    stagingToMain: number | null;
    devToMain: number;
    defaultBranch: string;
  }>;
}

export interface SecuritySummaryResponse {
  openCount: number;
  criticalCount: number;
  incidents: Array<{ id: string; title: string; severity: string; status: string }>;
}
>>>>>>> origin/main
