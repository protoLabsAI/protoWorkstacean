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
};

export const getTopics = () => apiFetch<string[]>("/api/topics");
export const getConsumers = () => apiFetch<string[]>("/api/consumers");
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
