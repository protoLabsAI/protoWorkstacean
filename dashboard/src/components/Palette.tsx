import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Badge, Card, Empty, Divider, type Status } from "@protolabsai/ui";
import { Boxes, ExternalLink, Globe, Plus, Search } from "lucide-react";
import {
  getControlPlaneState,
  probeAgentCard,
  createA2aEndpoint,
  getAdminKey,
  setAdminKey,
  type AgentsRuntimeResponse,
  type McpServerSummary,
} from "../lib/api";

/**
 * Palette — the canvas's companion surface (ADR-0008 P1, WS-4).
 *
 * A searchable, tier-tagged catalog of the live fleet registry
 * (/api/control-plane/state): in-process `builtin` agents · distributed `a2a`
 * agents · MCP tool servers. Each entry links onto the canvas (/system) and its
 * dispatch log (/executions?target=). "Add a node" reuses the shipped
 * control-plane write API (probe → createA2aEndpoint) — no new mutation path;
 * richer in-process-agent / MCP authoring stays in the Console.
 *
 * Acceptance: registering an A2A agent here makes it appear as a canvas node
 * within the hot-reload window.
 */

type Agent = AgentsRuntimeResponse["agents"][number];

const tierLabel = (a: Agent) => (a.type === "a2a" ? "a2a" : "builtin");
function tierStatus(a: Agent): Status {
  if (a.pendingDiscovery) return "warning";
  return a.type === "a2a" ? "info" : "neutral";
}
function trustStatus(t: McpServerSummary["trust"]): Status {
  if (t === "builtin") return "info";
  if (t === "trusted") return "success";
  return "neutral";
}

const inputStyle = {
  background: "var(--bg-default)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: "6px",
  padding: "8px 10px",
  fontSize: "13px",
  fontFamily: "var(--pl-font-mono)",
} as const;

const linkStyle = { display: "inline-flex", alignItems: "center", gap: "4px", fontSize: "12px", color: "var(--accent-fg)", textDecoration: "none" } as const;

export default function Palette() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServerSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState("");

  // Add-a-node (A2A) — reuses the Console's probe→register flow.
  const [key, setKey] = useState(getAdminKey());
  const [probeUrl, setProbeUrl] = useState("");
  const [probeName, setProbeName] = useState("");
  const [probe, setProbe] = useState<{ reachable: boolean; name?: string; skills: string[]; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getControlPlaneState(true);
      setAgents(data.agents ?? []);
      setMcpServers(data.mcpServers ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const needle = q.trim().toLowerCase();
  const visibleAgents = useMemo(
    () => (needle
      ? agents.filter((a) => a.name.toLowerCase().includes(needle) || a.type.toLowerCase().includes(needle)
          || (a.host ?? "").toLowerCase().includes(needle) || a.skills.some((s) => s.toLowerCase().includes(needle)))
      : agents),
    [agents, needle],
  );
  const visibleMcp = useMemo(
    () => (needle
      ? mcpServers.filter((s) => s.name.toLowerCase().includes(needle) || s.trust.toLowerCase().includes(needle)
          || s.transport.toLowerCase().includes(needle))
      : mcpServers),
    [mcpServers, needle],
  );

  function saveKey(v: string) { setKey(v); setAdminKey(v); }

  async function onProbe() {
    setBusy(true); setProbe(null);
    const r = await probeAgentCard(probeUrl.trim());
    setBusy(false);
    if (!r.ok) { setProbe({ reachable: false, skills: [], error: `${r.status}: ${(r.body?.error as string) ?? "probe failed"}` }); return; }
    const name = r.body?.name as string | undefined;
    if (name && !probeName) setProbeName(name);
    setProbe({
      reachable: Boolean(r.body?.reachable),
      name,
      skills: (r.body?.skills as string[] | undefined) ?? [],
      error: r.body?.error as string | undefined,
    });
  }

  async function onRegister() {
    const name = probeName.trim();
    if (!name) { setResult({ ok: false, msg: "Set a registry name for the A2A agent." }); return; }
    setBusy(true);
    const r = await createA2aEndpoint({ name, url: probeUrl.trim(), streaming: true });
    setBusy(false);
    if (r.ok) {
      setResult({ ok: true, msg: `Registered "${name}" — appears on the canvas within the hot-reload window (~5s).` });
      setProbe(null); setProbeUrl(""); setProbeName("");
      setTimeout(() => void refresh(), 1500);
      void refresh();
    } else {
      setResult({ ok: false, msg: `${r.status}: ${(r.body?.error as string) ?? "register failed"}` });
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px", maxWidth: "880px" }}>
      <div>
        <h2 style={{ color: "var(--text-primary)", marginBottom: "4px", display: "flex", alignItems: "center", gap: "8px" }}>
          <Boxes size={18} /> Palette
        </h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
          The live fleet registry — search it, and add nodes to the canvas. In-process <code>builtin</code> agents,
          distributed <code>a2a</code> agents, and MCP tool servers. Full agent/MCP authoring lives in the <Link to="/console" style={{ color: "var(--accent-fg)" }}>Console</Link>.
        </p>
      </div>

      {/* Search */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <Search size={15} color="var(--text-secondary)" />
        <input
          value={q}
          placeholder="Filter by name, tier, skill, host, tool…"
          onChange={(e) => setQ(e.currentTarget.value)}
          style={{ ...inputStyle, fontFamily: "inherit", flex: 1 }}
        />
      </div>

      {loadError && (
        <Card>
          <span style={{ color: "var(--text-danger)", fontSize: "13px" }}>✗ Failed to load registry: {loadError}</span>
        </Card>
      )}

      {/* Agents */}
      <div>
        <strong style={{ color: "var(--text-primary)", fontSize: "14px", display: "block", marginBottom: "8px" }}>
          Agents ({visibleAgents.length}{needle && agents.length !== visibleAgents.length ? ` / ${agents.length}` : ""})
        </strong>
        {visibleAgents.length === 0 ? (
          <Empty>{needle ? "No agents match." : "No agents registered."}</Empty>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {visibleAgents.map((a) => (
              <Card key={a.name}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <strong style={{ color: "var(--text-primary)", fontSize: "14px" }}>{a.name}</strong>
                  <Badge status={tierStatus(a)}>{a.pendingDiscovery ? "discovering" : tierLabel(a)}</Badge>
                  {a.type === "a2a" && a.host && (
                    <span style={{ color: "var(--text-secondary)", fontSize: "12px", fontFamily: "var(--pl-font-mono)" }}>⤳ {a.host}</span>
                  )}
                  <span style={{ flex: 1, display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    {a.skills.map((s) => <Badge key={s} status="neutral">{s}</Badge>)}
                  </span>
                  <Link to="/system" style={linkStyle} title="View on the canvas"><ExternalLink size={12} /> canvas</Link>
                  <Link to={`/executions?target=${encodeURIComponent(a.name)}`} style={linkStyle} title="View this agent's dispatches">executions</Link>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* MCP tools */}
      <div>
        <strong style={{ color: "var(--text-primary)", fontSize: "14px", display: "block", marginBottom: "8px" }}>
          MCP tools ({visibleMcp.length}{needle && mcpServers.length !== visibleMcp.length ? ` / ${mcpServers.length}` : ""})
        </strong>
        {visibleMcp.length === 0 ? (
          <Empty>{needle ? "No MCP servers match." : "No MCP servers registered."}</Empty>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {visibleMcp.map((s) => (
              <Card key={s.name}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <strong style={{ color: "var(--text-primary)", fontSize: "14px" }}>{s.name}</strong>
                  <Badge status={trustStatus(s.trust)}>{s.trust}</Badge>
                  <Badge status={s.enabled ? "success" : "neutral"}>{s.enabled ? "enabled" : "disabled"}</Badge>
                  <Badge status="neutral">{s.transport}</Badge>
                  <span style={{ flex: 1, display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    {s.grants.map((g) => <Badge key={g} status="warning">{g}</Badge>)}
                  </span>
                  <Link to="/console" style={linkStyle} title="Manage in the Console">manage</Link>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Divider />

      {/* Add a node — A2A probe→register (acceptance path) */}
      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div>
            <strong style={{ color: "var(--text-primary)", fontSize: "14px", display: "flex", alignItems: "center", gap: "6px" }}>
              <Plus size={14} /> Add an A2A node
            </strong>
            <p style={{ color: "var(--text-secondary)", fontSize: "12px", margin: "2px 0 0" }}>
              Probe a remote agent's card, then register it — it joins the fleet and the canvas live. Needs the admin key.
              For in-process agents or MCP servers, use the <Link to="/console" style={{ color: "var(--accent-fg)" }}>Console</Link>.
            </p>
          </div>

          <input
            type="password"
            value={key}
            placeholder="Admin key (WORKSTACEAN_API_KEY)"
            onChange={(e) => saveKey(e.currentTarget.value)}
            style={{ ...inputStyle, fontFamily: "inherit", maxWidth: "360px" }}
          />

          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <input
              value={probeUrl}
              placeholder="https://agent.example/ (base URL)"
              onChange={(e) => setProbeUrl(e.currentTarget.value)}
              style={{ ...inputStyle, fontFamily: "inherit", flex: 1 }}
            />
            <Button onClick={() => void onProbe()} disabled={busy || !probeUrl.trim()}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><Globe size={14} /> Probe</span>
            </Button>
          </div>

          {probe && (
            probe.reachable ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <Badge status="success">reachable</Badge>
                  {probe.name && <strong style={{ color: "var(--text-primary)", fontSize: "13px" }}>{probe.name}</strong>}
                  {probe.skills.length === 0
                    ? <span style={{ color: "var(--text-secondary)", fontSize: "12px" }}>no skills advertised</span>
                    : probe.skills.map((s) => <Badge key={s} status="neutral">{s}</Badge>)}
                </div>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <input
                    value={probeName}
                    placeholder="registry name (e.g. roxy)"
                    onChange={(e) => setProbeName(e.currentTarget.value)}
                    style={{ ...inputStyle, fontFamily: "inherit", flex: 1 }}
                  />
                  <Button variant="primary" onClick={() => void onRegister()} disabled={busy || !probeName.trim()}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><Plus size={14} /> Register</span>
                  </Button>
                </div>
              </>
            ) : (
              <span style={{ color: "var(--text-danger)", fontSize: "13px" }}>✗ {probe.error}</span>
            )
          )}

          {result && (
            <span style={{ color: result.ok ? "var(--text-success)" : "var(--text-danger)", fontSize: "13px" }}>
              {result.ok ? "✓ " : "✗ "}{result.msg}
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}
