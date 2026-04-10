import { useState, useEffect } from "preact/hooks";

type Status = "green" | "yellow" | "red" | "loading";

interface CardState {
  label: string;
  metric: string;
  status: Status;
}

const POLL_INTERVAL = 30_000;

function deriveServicesStatus(data: unknown): Pick<CardState, "metric" | "status"> {
  if (!data || typeof data !== "object") return { metric: "Unknown", status: "loading" };
  const entries = Object.values(data as Record<string, { status?: string }>);
  if (entries.length === 0) return { metric: "No services", status: "yellow" };
  const down = entries.filter((s) => s?.status === "down").length;
  const degraded = entries.filter((s) => s?.status === "degraded").length;
  if (down > 0) return { metric: `${down} down`, status: "red" };
  if (degraded > 0) return { metric: `${degraded} degraded`, status: "yellow" };
  return { metric: `${entries.length} healthy`, status: "green" };
}

function deriveAgentHealthStatus(data: unknown): Pick<CardState, "metric" | "status"> {
  if (!data || typeof data !== "object") return { metric: "Unknown", status: "loading" };
  const agents = (data as { agents?: Array<{ status?: string }> }).agents ?? [];
  if (agents.length === 0) return { metric: "None registered", status: "red" };
  const active = agents.filter((a) => a?.status === "active" || a?.status === "idle" || a?.status === "registered").length;
  const errored = agents.filter((a) => a?.status === "error").length;
  if (errored === agents.length) return { metric: `${errored} errors`, status: "red" };
  return { metric: `${active} / ${agents.length} online`, status: errored > 0 ? "yellow" : "green" };
}

function deriveCiHealthStatus(data: unknown): Pick<CardState, "metric" | "status"> {
  if (!data || typeof data !== "object") return { metric: "Unknown", status: "loading" };
  const projects = (data as { projects?: Array<{ successRate?: number }> }).projects ?? [];
  if (projects.length === 0) return { metric: "No data", status: "yellow" };
  const avg = projects.reduce((sum, p) => sum + (p?.successRate ?? 0), 0) / projects.length;
  const pct = Math.round(avg * 100);
  if (avg >= 0.8) return { metric: `${pct}% pass rate`, status: "green" };
  if (avg >= 0.5) return { metric: `${pct}% pass rate`, status: "yellow" };
  return { metric: `${pct}% pass rate`, status: "red" };
}

function derivePrPipelineStatus(data: unknown): Pick<CardState, "metric" | "status"> {
  if (!data || typeof data !== "object") return { metric: "Unknown", status: "loading" };
  const { open = 0, failed = 0 } = data as { open?: number; failed?: number };
  if (failed > 0) return { metric: `${failed} failed`, status: "red" };
  if (open > 5) return { metric: `${open} open`, status: "yellow" };
  return { metric: `${open} open`, status: "green" };
}

function deriveFlowMetricsStatus(data: unknown): Pick<CardState, "metric" | "status"> {
  if (!data || typeof data !== "object") return { metric: "Unknown", status: "loading" };
  const { eventsPerMinute = 0, totalEvents = 0 } = data as {
    eventsPerMinute?: number;
    totalEvents?: number;
  };
  const epm = typeof eventsPerMinute === "number" ? eventsPerMinute : 0;
  return {
    metric: `${epm.toFixed(1)} ev/min (${totalEvents} total)`,
    status: epm > 0 ? "green" : "yellow",
  };
}

function deriveSecurityStatus(data: unknown): Pick<CardState, "metric" | "status"> {
  if (!data || typeof data !== "object") return { metric: "Unknown", status: "loading" };
  const d = data as { openIncidents?: number; incidents?: unknown[] };
  const count = d.openIncidents ?? d.incidents?.length ?? 0;
  if (count === 0) return { metric: "No incidents", status: "green" };
  return { metric: `${count} open`, status: "red" };
}

function deriveHitlStatus(data: unknown): Pick<CardState, "metric" | "status"> {
  if (!data || typeof data !== "object") return { metric: "Unknown", status: "loading" };
  const pending = (data as { pending?: unknown[] }).pending ?? [];
  const count = pending.length;
  if (count === 0) return { metric: "None pending", status: "green" };
  if (count <= 3) return { metric: `${count} pending`, status: "yellow" };
  return { metric: `${count} pending`, status: "red" };
}

async function fetchCard(
  endpoint: string,
  derive: (data: unknown) => Pick<CardState, "metric" | "status">
): Promise<Pick<CardState, "metric" | "status">> {
  try {
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    return derive(data);
  } catch {
    return { metric: "Error", status: "red" };
  }
}

const CARD_CONFIGS: Array<{
  label: string;
  endpoint: string;
  derive: (data: unknown) => Pick<CardState, "metric" | "status">;
}> = [
  { label: "Service Connectivity", endpoint: "/api/services", derive: deriveServicesStatus },
  { label: "Agent Health", endpoint: "/api/agent-health", derive: deriveAgentHealthStatus },
  { label: "CI Success Rate", endpoint: "/api/ci-health", derive: deriveCiHealthStatus },
  { label: "PR Pipeline", endpoint: "/api/pr-pipeline", derive: derivePrPipelineStatus },
  { label: "Flow Metrics", endpoint: "/api/flow-metrics", derive: deriveFlowMetricsStatus },
  { label: "Security Summary", endpoint: "/api/security-summary", derive: deriveSecurityStatus },
  { label: "Pending HITL", endpoint: "/api/hitl/pending", derive: deriveHitlStatus },
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
  const [cards, setCards] = useState<CardState[]>(
    CARD_CONFIGS.map((c) => ({ label: c.label, metric: "Loading…", status: "loading" as Status }))
  );

  async function refresh() {
    const results = await Promise.all(
      CARD_CONFIGS.map((c) => fetchCard(c.endpoint, c.derive))
    );
    setCards(
      CARD_CONFIGS.map((c, i) => ({ label: c.label, ...results[i] }))
    );
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_INTERVAL);
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
