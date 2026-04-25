// API response types for all /api/* endpoints

export interface WorldStateSnapshot {
  timestamp: string;
  domains: Record<string, DomainState>;
}

export interface DomainState {
  [key: string]: unknown;
}

export interface ServiceHealth {
  name: string;
  status: "healthy" | "degraded" | "down" | "unknown";
  latency?: number;
  lastChecked?: string;
}

export interface ServicesResponse {
  discord?: ServiceHealth;
  github?: ServiceHealth;
  [key: string]: ServiceHealth | undefined;
}

export interface AgentHealth {
  id: string;
  name: string;
  status: "registered" | "idle" | "active" | "error";
  lastSeen?: string;
}

export interface AgentHealthResponse {
  agents: AgentHealth[];
}

export interface FlowMetrics {
  totalEvents: number;
  eventsPerMinute: number;
  topTopics: Array<{ topic: string; count: number }>;
}

export interface Outcome {
  id: string;
  action: string;
  status: "success" | "failure" | "pending";
  timestamp: string;
  result?: unknown;
}

export interface OutcomesResponse {
  outcomes: Outcome[];
}

export interface CiHealth {
  projects: Array<{
    name: string;
    successRate: number;
    lastRun?: string;
    status: string;
  }>;
}

export interface PrPipeline {
  open: number;
  merged: number;
  failed: number;
  prs: Array<{
    number: number;
    title: string;
    status: string;
    repo: string;
  }>;
}

export interface Goal {
  id: string;
  name: string;
  description?: string;
  status: "active" | "achieved" | "failed" | "pending";
  conditions?: Record<string, unknown>;
}

export interface GoalsResponse {
  goals: Goal[];
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  status?: string;
}

export interface ProjectsResponse {
  success: boolean;
  data: Project[];
}

export interface Channel {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
}

export interface ChannelsResponse {
  channels: Channel[];
}

export interface HitlRequest {
  id: string;
  question: string;
  context?: unknown;
  createdAt: string;
}

export interface HitlPendingResponse {
  pending: HitlRequest[];
}

export interface BusEvent {
  topic: string;
  payload: unknown;
  timestamp: string;
}

export interface ApiEventsResponse {
  events: BusEvent[];
}

export interface WsStatus {
  connected: boolean;
  reconnecting: boolean;
}
