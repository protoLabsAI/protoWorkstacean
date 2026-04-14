import { useState, useEffect } from "preact/hooks";
import {
  getAgents,
  getAgentHealth,
  getCeremonies,
  peek,
  type AgentHealthResponse,
} from "../lib/api";

interface AgentDef {
  name: string;
  url?: string;
  skills?: Array<{ name: string; description?: string }>;
  subscribesTo?: string[];
}

interface Ceremony {
  id: string;
  name: string;
  schedule: string;
  skill: string;
  targets?: string[];
  enabled?: boolean;
}

interface AgentCard {
  name: string;
  url: string;
  skills: Array<{ name: string; description?: string }>;
  ceremonies: Ceremony[];
  registered: boolean;
  executorType: string | null;
}

const POLL_INTERVAL = 30_000;

export default function AgentsView() {
  const [agents, setAgents] = useState<AgentCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);

  async function refresh(force = false) {
    try {
      const [agentDefs, health, ceremonyData] = await Promise.all([
        getAgents() as Promise<{ agents?: AgentDef[] } | AgentDef[]>,
        getAgentHealth(force),
        getCeremonies() as Promise<Ceremony[] | { data: Ceremony[] }>,
      ]);

      const defs: AgentDef[] = Array.isArray(agentDefs)
        ? agentDefs
        : (agentDefs as { agents?: AgentDef[] }).agents ?? [];

      const ceremonies: Ceremony[] = Array.isArray(ceremonyData)
        ? ceremonyData
        : (ceremonyData as { data: Ceremony[] }).data ?? [];

      const registeredAgents = health.agents ?? {};

      const cards: AgentCard[] = defs.map((def) => {
        const reg = registeredAgents[def.name];
        const agentCeremonies = ceremonies.filter(
          (c) => c.targets?.includes(def.name),
        );

        return {
          name: def.name,
          url: def.url ?? "",
          skills: def.skills ?? [],
          ceremonies: agentCeremonies,
          registered: !!reg,
          executorType: reg?.executorType ?? null,
        };
      });

      // Sort: registered first, then alphabetical
      cards.sort((a, b) => {
        if (a.registered !== b.registered) return a.registered ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      setAgents(cards);
      setLoading(false);
    } catch (err) {
      console.error("Failed to load agents:", err);
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh(true);
    const id = setInterval(() => refresh(true), POLL_INTERVAL);
    return () => clearInterval(id);
  }, []);

  if (loading && agents.length === 0) {
    return <div style={{ color: "var(--text-secondary)", padding: "48px", textAlign: "center" }}>Loading agents...</div>;
  }

  return (
    <>
      <style>{`
        .agents-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
          gap: 16px;
        }
        .agent-card {
          background: var(--bg-default);
          border: 1px solid var(--border-default);
          border-radius: 6px;
          overflow: hidden;
          transition: border-color 0.15s;
        }
        .agent-card:hover {
          border-color: var(--accent-fg);
        }
        .agent-card-header {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 16px;
          cursor: pointer;
          user-select: none;
        }
        .agent-status-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .agent-name {
          font-size: 15px;
          font-weight: 600;
          color: var(--text-primary);
          flex: 1;
        }
        .agent-type-badge {
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 12px;
          font-weight: 500;
        }
        .agent-details {
          border-top: 1px solid var(--border-muted);
          padding: 16px;
        }
        .detail-section {
          margin-bottom: 16px;
        }
        .detail-section:last-child {
          margin-bottom: 0;
        }
        .detail-label {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          margin-bottom: 8px;
        }
        .detail-url {
          font-family: SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace;
          font-size: 12px;
          color: var(--text-secondary);
          word-break: break-all;
        }
        .skill-list {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .skill-tag {
          font-size: 12px;
          padding: 3px 10px;
          border-radius: 12px;
          background: rgba(88, 166, 255, 0.1);
          color: var(--accent-fg);
          font-family: SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace;
        }
        .ceremony-row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 0;
          font-size: 12px;
          border-bottom: 1px solid var(--border-muted);
        }
        .ceremony-row:last-child {
          border-bottom: none;
        }
        .ceremony-name {
          color: var(--text-primary);
          font-weight: 500;
          flex: 1;
        }
        .ceremony-schedule {
          font-family: SFMono-Regular, Consolas, Liberation Mono, Menlo, monospace;
          color: var(--text-secondary);
          font-size: 11px;
        }
        .ceremony-enabled {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .no-ceremonies {
          color: var(--text-secondary);
          font-size: 12px;
          font-style: italic;
        }
        .agent-summary {
          display: flex;
          gap: 16px;
          margin-bottom: 20px;
          font-size: 13px;
          color: var(--text-secondary);
        }
        .agent-summary-item {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .agent-summary-count {
          font-size: 18px;
          font-weight: 600;
          color: var(--text-primary);
        }
        .chevron {
          color: var(--text-secondary);
          font-size: 12px;
          transition: transform 0.15s;
        }
        .chevron--open {
          transform: rotate(90deg);
        }
      `}</style>

      <div class="agent-summary">
        <div class="agent-summary-item">
          <span class="agent-summary-count">{agents.length}</span>
          agents
        </div>
        <div class="agent-summary-item">
          <span class="agent-summary-count">{agents.filter((a) => a.registered).length}</span>
          registered
        </div>
        <div class="agent-summary-item">
          <span class="agent-summary-count">
            {agents.reduce((sum, a) => sum + a.skills.length, 0)}
          </span>
          skills
        </div>
        <div class="agent-summary-item">
          <span class="agent-summary-count">
            {agents.reduce((sum, a) => sum + a.ceremonies.filter((c) => c.enabled !== false).length, 0)}
          </span>
          active jobs
        </div>
      </div>

      <div class="agents-grid">
        {agents.map((agent) => {
          const isExpanded = expandedAgent === agent.name;
          const activeCeremonies = agent.ceremonies.filter((c) => c.enabled !== false);

          return (
            <div
              class="agent-card"
              key={agent.name}
              style={{
                borderColor: agent.registered
                  ? "rgba(63, 185, 80, 0.3)"
                  : "var(--border-default)",
              }}
            >
              <div
                class="agent-card-header"
                onClick={() => setExpandedAgent(isExpanded ? null : agent.name)}
              >
                <span
                  class="agent-status-dot"
                  style={{
                    background: agent.registered ? "#3fb950" : "#8b949e",
                    boxShadow: agent.registered ? "0 0 4px #3fb950" : "none",
                  }}
                />
                <span class="agent-name">{agent.name}</span>
                {agent.executorType && (
                  <span
                    class="agent-type-badge"
                    style={{
                      background: "rgba(88, 166, 255, 0.1)",
                      color: "var(--accent-fg)",
                    }}
                  >
                    {agent.executorType}
                  </span>
                )}
                <span style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                  {agent.skills.length} skills
                  {activeCeremonies.length > 0 && ` / ${activeCeremonies.length} jobs`}
                </span>
                <span class={`chevron ${isExpanded ? "chevron--open" : ""}`}>
                  &#9654;
                </span>
              </div>

              {isExpanded && (
                <div class="agent-details">
                  {agent.url && (
                    <div class="detail-section">
                      <div class="detail-label">Endpoint</div>
                      <div class="detail-url">{agent.url}</div>
                    </div>
                  )}

                  <div class="detail-section">
                    <div class="detail-label">Skills</div>
                    {agent.skills.length > 0 ? (
                      <div class="skill-list">
                        {agent.skills.map((s) => (
                          <span class="skill-tag" key={s.name} title={s.description}>
                            {s.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div class="no-ceremonies">No skills registered</div>
                    )}
                  </div>

                  <div class="detail-section">
                    <div class="detail-label">Recurring Jobs</div>
                    {agent.ceremonies.length > 0 ? (
                      agent.ceremonies.map((c) => (
                        <div class="ceremony-row" key={c.id}>
                          <span
                            class="ceremony-enabled"
                            style={{
                              background: c.enabled !== false ? "#3fb950" : "#8b949e",
                            }}
                          />
                          <span class="ceremony-name">{c.name || c.id}</span>
                          <span class="ceremony-schedule">{c.schedule}</span>
                        </div>
                      ))
                    ) : (
                      <div class="no-ceremonies">No recurring jobs</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
