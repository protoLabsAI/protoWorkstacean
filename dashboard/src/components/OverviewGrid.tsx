import { useState, useEffect } from "preact/hooks";
import {
  getServices,
  getAgentHealth,
  getCiHealth,
  getPrPipeline,
  getFlowMetrics,
  getSecuritySummary,
  getHitlPending,
  peek,
  type ServicesResponse,
  type AgentHealthResponse,
  type CiHealthResponse,
  type PrPipelineResponse,
  type FlowMetricsResponse,
  type SecuritySummaryResponse,
} from "../lib/api";

type Status = "green" | "yellow" | "red" | "loading";

interface CardState {
  label: string;
  metric: string;
  status: Status;
}

const POLL_INTERVAL = 30_000;

function deriveServicesStatus(data: ServicesResponse): Pick<CardState, "metric" | "status"> {
  // Services response: { discord: { configured, connected }, github: { configured, ... }, ... }
  const services = Object.entries(data).filter(([, v]) => v && typeof v === "object");
  if (services.length === 0) return { metric: "No services", status: "yellow" };

  const configured = services.filter(([, v]) => (v as { configured?: boolean }).configured);
  const unhealthy = configured.filter(([name, v]) => {
    // "connected" for Discord, "configured" is enough for the rest
    if (name === "discord") return !(v as { connected?: boolean }).connected;
    return false;
  });

  if (unhealthy.length > 0) {
    return { metric: `${unhealthy.length} unhealthy`, status: "red" };
  }
  return { metric: `${configured.length} healthy`, status: "green" };
}

function deriveAgentHealthStatus(data: AgentHealthResponse): Pick<CardState, "metric" | "status"> {
  const count = data.agentCount ?? 0;
  if (count === 0) return { metric: "None registered", status: "red" };
  return { metric: `${count} registered`, status: "green" };
}

function deriveCiHealthStatus(data: CiHealthResponse): Pick<CardState, "metric" | "status"> {
  const { successRate = 1, totalRuns = 0, projects = [] } = data;
  if (totalRuns === 0 || projects.length === 0) return { metric: "No data", status: "yellow" };
  const pct = Math.round(successRate * 100);
  if (successRate >= 0.8) return { metric: `${pct}% pass rate`, status: "green" };
  if (successRate >= 0.5) return { metric: `${pct}% pass rate`, status: "yellow" };
  return { metric: `${pct}% pass rate`, status: "red" };
}

function derivePrPipelineStatus(data: PrPipelineResponse): Pick<CardState, "metric" | "status"> {
  const { totalOpen = 0, conflicting = 0, stale = 0, failingCi = 0, changesRequested = 0, readyToMerge = 0 } = data;
  if (conflicting > 0 || failingCi > 0 || changesRequested > 0) {
    return { metric: `${conflicting + failingCi + changesRequested} needs attention`, status: "red" };
  }
  if (stale > 0) return { metric: `${stale} stale`, status: "yellow" };
  if (readyToMerge > 0) return { metric: `${readyToMerge} ready to merge`, status: "green" };
  return { metric: `${totalOpen} open`, status: "green" };
}

function deriveFlowMetricsStatus(data: FlowMetricsResponse): Pick<CardState, "metric" | "status"> {
  const efficiency = data.efficiency;
  if (!efficiency) return { metric: "No data", status: "yellow" };
  const pct = Math.round((efficiency.ratio ?? 0) * 100);
  return {
    metric: `${pct}% efficiency`,
    status: efficiency.healthy ? "green" : "yellow",
  };
}

function deriveSecurityStatus(data: SecuritySummaryResponse): Pick<CardState, "metric" | "status"> {
  const { openCount = 0, criticalCount = 0 } = data;
  if (criticalCount > 0) return { metric: `${criticalCount} critical`, status: "red" };
  if (openCount > 0) return { metric: `${openCount} open`, status: "yellow" };
  return { metric: "No incidents", status: "green" };
}

function deriveHitlStatus(data: { data?: unknown[] }): Pick<CardState, "metric" | "status"> {
  const pending = Array.isArray(data?.data) ? data.data : [];
  const count = pending.length;
  if (count === 0) return { metric: "None pending", status: "green" };
  if (count <= 3) return { metric: `${count} pending`, status: "yellow" };
  return { metric: `${count} pending`, status: "red" };
}

interface CardFetcher {
  label: string;
  endpoint: string;
  fetch: (force?: boolean) => Promise<Pick<CardState, "metric" | "status">>;
  seedFromCache: () => Pick<CardState, "metric" | "status"> | null;
}

async function safeFetch<T>(
  loader: (force?: boolean) => Promise<T>,
  derive: (data: T) => Pick<CardState, "metric" | "status">,
  force: boolean,
): Promise<Pick<CardState, "metric" | "status">> {
  try {
    const data = await loader(force);
    return derive(data);
  } catch {
    return { metric: "Error", status: "red" };
  }
}

const CARD_CONFIGS: CardFetcher[] = [
  {
    label: "Service Connectivity",
    endpoint: "/api/services",
    fetch: (force) => safeFetch(getServices, deriveServicesStatus, force ?? false),
    seedFromCache: () => {
      const cached = peek<ServicesResponse>("/api/services");
      return cached ? deriveServicesStatus(cached) : null;
    },
  },
  {
    label: "Agent Health",
    endpoint: "/api/agent-health",
    fetch: (force) => safeFetch(getAgentHealth, deriveAgentHealthStatus, force ?? false),
    seedFromCache: () => {
      const cached = peek<AgentHealthResponse>("/api/agent-health");
      return cached ? deriveAgentHealthStatus(cached) : null;
    },
  },
  {
    label: "CI Success Rate",
    endpoint: "/api/ci-health",
    fetch: (force) => safeFetch(getCiHealth, deriveCiHealthStatus, force ?? false),
    seedFromCache: () => {
      const cached = peek<CiHealthResponse>("/api/ci-health");
      return cached ? deriveCiHealthStatus(cached) : null;
    },
  },
  {
    label: "PR Pipeline",
    endpoint: "/api/pr-pipeline",
    fetch: (force) => safeFetch(getPrPipeline, derivePrPipelineStatus, force ?? false),
    seedFromCache: () => {
      const cached = peek<PrPipelineResponse>("/api/pr-pipeline");
      return cached ? derivePrPipelineStatus(cached) : null;
    },
  },
  {
    label: "Flow Efficiency",
    endpoint: "/api/flow-metrics",
    fetch: (force) => safeFetch(getFlowMetrics, deriveFlowMetricsStatus, force ?? false),
    seedFromCache: () => {
      const cached = peek<FlowMetricsResponse>("/api/flow-metrics");
      return cached ? deriveFlowMetricsStatus(cached) : null;
    },
  },
  {
    label: "Security",
    endpoint: "/api/security-summary",
    fetch: (force) => safeFetch(getSecuritySummary, deriveSecurityStatus, force ?? false),
    seedFromCache: () => {
      const cached = peek<SecuritySummaryResponse>("/api/security-summary");
      return cached ? deriveSecurityStatus(cached) : null;
    },
  },
  {
    label: "Pending HITL",
    endpoint: "/api/hitl/pending",
    fetch: (force) => safeFetch(getHitlPending, deriveHitlStatus, force ?? false),
    seedFromCache: () => {
      const cached = peek<{ data?: unknown[] }>("/api/hitl/pending");
      return cached ? deriveHitlStatus(cached) : null;
    },
  },
];

function HealthCardView({ label, metric, status }: CardState) {
  const dotStyle: Record<Status, string> = {
    green: "#3fb950",
    yellow: "#d29922",
    red: "#f85149",
    loading: "#8b949e",
  };

  const borderColor: Record<Status, string> = {
    green: "rgba(63, 185, 80, 0.3)",
    yellow: "rgba(210, 153, 34, 0.3)",
    red: "rgba(248, 81, 73, 0.3)",
    loading: "#21262d",
  };

  return (
    <div
      class="card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        borderColor: borderColor[status],
      }}
    >
      <div class="card-title">{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <span
          style={{
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            flexShrink: 0,
            background: dotStyle[status],
            animation: status === "loading" ? "pulse 1.2s ease-in-out infinite" : "none",
          }}
        />
        <span
          style={{
            fontSize: "22px",
            fontWeight: 600,
            color: "var(--text-primary)",
            lineHeight: 1.2,
          }}
        >
          {metric}
        </span>
      </div>
    </div>
  );
}

export default function OverviewGrid() {
  // Seed from cache instantly so page revisits render immediately
  const [cards, setCards] = useState<CardState[]>(() =>
    CARD_CONFIGS.map((c) => {
      const cached = c.seedFromCache();
      return {
        label: c.label,
        metric: cached?.metric ?? "Loading…",
        status: cached?.status ?? ("loading" as Status),
      };
    }),
  );

  async function refresh(force = false) {
    const results = await Promise.all(CARD_CONFIGS.map((c) => c.fetch(force)));
    setCards(CARD_CONFIGS.map((c, i) => ({ label: c.label, ...results[i] })));
  }

  useEffect(() => {
    refresh(true); // force on mount to get fresh data
    const id = setInterval(() => refresh(true), POLL_INTERVAL);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 1; }
        }
        .overview-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
          gap: 16px;
        }
      `}</style>
      <div class="overview-grid">
        {cards.map((card) => (
          <HealthCardView key={card.label} {...card} />
        ))}
      </div>
    </>
  );
}
