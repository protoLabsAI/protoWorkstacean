/**
 * WorldState TypeScript schema — typed core properties with generic extension mechanism.
 *
 * Domains:
 *   - services: infrastructure / service health (30s tick)
 *   - board:    Plane project board state (60s tick)
 *   - ci:       GitHub CI pipeline state (5min tick)
 *   - portfolio: workspace project portfolio (15min tick)
 *
 * The `extensions` field provides a generic Record-based mechanism for domain-specific
 * data that does not fit the core domain types.
 */

// ── Service state ─────────────────────────────────────────────────────────────

export interface ServiceInstance {
  name: string;
  status: "healthy" | "degraded" | "down" | "unknown";
  uptime?: number;        // seconds
  lastChecked: number;    // Unix timestamp ms
  meta?: Record<string, unknown>;
}

export interface ServiceState {
  instances: ServiceInstance[];
  totalHealthy: number;
  totalDegraded: number;
  totalDown: number;
}

// ── Board state ───────────────────────────────────────────────────────────────

export interface BoardIssue {
  id: string;
  title: string;
  status: string;
  priority?: string;
  assignee?: string;
  updatedAt?: string;
}

export interface BoardState {
  projectSlug: string;
  openIssues: number;
  inProgress: number;
  done: number;
  issues: BoardIssue[];
}

// ── CI state ──────────────────────────────────────────────────────────────────

export interface CIRun {
  id: string;
  name: string;
  status: "success" | "failure" | "pending" | "running" | "cancelled" | string;
  branch: string;
  startedAt?: string;
  finishedAt?: string;
  url?: string;
}

export interface CIState {
  repository: string;
  runs: CIRun[];
  successRate?: number;   // 0.0 – 1.0
}

// ── Portfolio state ───────────────────────────────────────────────────────────

export interface PortfolioProject {
  slug: string;
  title: string;
  github: string;
  status: "active" | "archived" | "paused" | string;
  agents: string[];
  lastActivity?: string;
}

export interface PortfolioState {
  totalProjects: number;
  activeProjects: number;
  projects: PortfolioProject[];
}

// ── Generic extension mechanism ───────────────────────────────────────────────

/** Arbitrary domain-specific extensions keyed by domain name or feature slug. */
export type WorldStateExtensions = Record<string, unknown>;

// ── Core world state container ────────────────────────────────────────────────

export interface WorldStateMetadata {
  collectedAt: number;    // Unix timestamp ms
  domain: string;
  tickNumber: number;
  failed?: boolean;
  errorMessage?: string;
}

export interface WorldStateDomain<T = unknown> {
  data: T;
  metadata: WorldStateMetadata;
}

export interface WorldState {
  timestamp: number;      // Unix timestamp ms of most recent update across all domains
  domains: {
    services?: WorldStateDomain<ServiceState>;
    board?: WorldStateDomain<BoardState>;
    ci?: WorldStateDomain<CIState>;
    portfolio?: WorldStateDomain<PortfolioState>;
  };
  /** Generic extension mechanism for future domains or domain-specific data. */
  extensions: WorldStateExtensions;
  snapshotVersion: number;
}

// ── Snapshot envelope ─────────────────────────────────────────────────────────

export interface WorldStateSnapshot {
  worldState: WorldState;
  createdAt: number;      // Unix timestamp ms
  version: number;
}
