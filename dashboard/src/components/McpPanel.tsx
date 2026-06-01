import { useState } from "react";
import { Button, Badge, Card, Empty, type Status } from "@protolabsai/ui";
import { Plus, Trash2, Globe, Power } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  probeMcpServer,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  getMcpServerDef,
  type McpServerSummary,
  type McpProbeResult,
} from "../lib/api";

// MCP servers pane (ADR-0005 P4) — the tool tier's slice of the Console.
// Register an MCP server → its tools become fleet executors. Trust tiers gate
// auto-enable (community stays off until the operator flips it); capability
// grants are an audit record in v1. Brand-native (@protolabsai/ui + --pl-*).

type Trust = McpServerSummary["trust"];
type Grant = McpServerSummary["grants"][number];

const TRUSTS: Trust[] = ["community", "trusted", "builtin"];
const GRANTS: Grant[] = ["network", "secrets", "filesystem"];

function trustStatus(t: Trust): Status {
  if (t === "builtin") return "info";
  if (t === "trusted") return "success";
  return "neutral"; // community
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

interface Props {
  servers: McpServerSummary[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  /** Re-fetch the control-plane state after a mutation (~live). */
  onChanged: () => void;
}

export default function McpPanel({ servers, busy, setBusy, onChanged }: Props) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "sse">("stdio");
  const [command, setCommand] = useState(""); // whitespace-split argv for stdio
  const [url, setUrl] = useState("");
  const [trust, setTrust] = useState<Trust>("community");
  const [grants, setGrants] = useState<Set<Grant>>(new Set());
  const [enabled, setEnabled] = useState(false);
  const [probe, setProbe] = useState<McpProbeResult | null>(null);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  function buildDef() {
    const def: Record<string, unknown> = { name: name.trim(), transport, trust, grants: [...grants], enabled };
    if (transport === "stdio") def.command = command.trim().split(/\s+/).filter(Boolean);
    else def.url = url.trim();
    return def;
  }

  function resetForm() {
    setName(""); setCommand(""); setUrl(""); setTrust("community");
    setGrants(new Set()); setEnabled(false); setProbe(null);
  }

  function toggleGrant(g: Grant) {
    setGrants((prev) => {
      const next = new Set(prev);
      next.has(g) ? next.delete(g) : next.add(g);
      return next;
    });
  }

  async function onProbe() {
    setBusy(true); setProbe(null);
    const r = await probeMcpServer(buildDef());
    setBusy(false);
    if (!r.ok) { setProbe({ reachable: false, error: `${r.status}: ${(r.body?.error as string) ?? "probe failed"}` }); return; }
    setProbe({
      reachable: Boolean(r.body?.reachable),
      tools: (r.body?.tools as Array<{ name: string; description?: string }> | undefined) ?? [],
      error: r.body?.error as string | undefined,
    });
  }

  async function onCreate() {
    if (!name.trim()) { setResult({ ok: false, msg: "Name is required." }); return; }
    setBusy(true);
    const r = await createMcpServer(buildDef());
    setBusy(false);
    if (r.ok) {
      setResult({ ok: true, msg: `Registered "${name}"${enabled ? " — tools connecting…" : " (disabled — enable to connect)"}.` });
      resetForm();
      onChanged();
    } else {
      setResult({ ok: false, msg: `${r.status}: ${(r.body?.error as string) ?? "create failed"}` });
    }
  }

  // Flip enabled: fetch the full stored def (the list summary omits command/url),
  // toggle, PUT it back. This is the ADR-0005 D2 "operator approves community" path.
  async function onToggleEnabled(server: McpServerSummary) {
    setBusy(true);
    const got = await getMcpServerDef(server.name);
    if (!got.ok || !got.body?.def) {
      setBusy(false);
      setResult({ ok: false, msg: `${got.status}: could not load "${server.name}"` });
      return;
    }
    const def = got.body.def as Record<string, unknown>;
    const r = await updateMcpServer(server.name, { ...def, enabled: !server.enabled });
    setBusy(false);
    setResult(r.ok
      ? { ok: true, msg: `"${server.name}" ${server.enabled ? "disabled" : "enabled"}.` }
      : { ok: false, msg: `${r.status}: ${(r.body?.error as string) ?? "update failed"}` });
    if (r.ok) onChanged();
  }

  async function doDelete() {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null); setBusy(true);
    const r = await deleteMcpServer(target);
    setBusy(false);
    setResult(r.ok ? { ok: true, msg: `Removed "${target}".` } : { ok: false, msg: `${r.status}: ${(r.body?.error as string) ?? "delete failed"}` });
    if (r.ok) onChanged();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div>
            <strong style={{ color: "var(--text-primary)", fontSize: "14px" }}>Register an MCP server</strong>
            <p style={{ color: "var(--text-secondary)", fontSize: "12px", margin: "2px 0 0" }}>
              Probe for tools, then register. Trust tier gates auto-enable — <code>community</code> stays off until you enable it. Grants are an audit record.
            </p>
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
            <input value={name} placeholder="name (e.g. filesystem)" onChange={(e) => setName(e.currentTarget.value)}
              style={{ ...inputStyle, fontFamily: "inherit", flex: "1 1 160px" }} />
            <select value={transport} onChange={(e) => setTransport(e.currentTarget.value as "stdio" | "sse")} style={{ ...inputStyle, fontFamily: "inherit" }}>
              <option value="stdio">stdio</option>
              <option value="sse">sse</option>
            </select>
            <select value={trust} onChange={(e) => setTrust(e.currentTarget.value as Trust)} style={{ ...inputStyle, fontFamily: "inherit" }}>
              {TRUSTS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          {transport === "stdio" ? (
            <input value={command} placeholder="command + args (e.g. npx -y @modelcontextprotocol/server-filesystem /data)"
              onChange={(e) => setCommand(e.currentTarget.value)} style={{ ...inputStyle, width: "100%" }} />
          ) : (
            <input value={url} placeholder="https://host/mcp (sse endpoint)"
              onChange={(e) => setUrl(e.currentTarget.value)} style={{ ...inputStyle, fontFamily: "inherit", width: "100%" }} />
          )}

          <div style={{ display: "flex", gap: "14px", alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "var(--text-secondary)", fontSize: "12px" }}>Grants:</span>
            {GRANTS.map((g) => (
              <label key={g} style={{ color: "var(--text-secondary)", fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <input type="checkbox" checked={grants.has(g)} onChange={() => toggleGrant(g)} /> {g}
              </label>
            ))}
            <label style={{ color: "var(--text-secondary)", fontSize: "12px", display: "inline-flex", alignItems: "center", gap: "4px", marginLeft: "auto" }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} /> enabled
            </label>
          </div>

          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <Button onClick={() => void onProbe()} disabled={busy || !name.trim() || (transport === "stdio" ? !command.trim() : !url.trim())}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><Globe size={14} /> Probe</span>
            </Button>
            <Button variant="primary" onClick={() => void onCreate()} disabled={busy || !name.trim()}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><Plus size={14} /> Register</span>
            </Button>
            {result && (
              <span style={{ color: result.ok ? "var(--text-success)" : "var(--text-danger)", fontSize: "13px" }}>
                {result.ok ? "✓ " : "✗ "}{result.msg}
              </span>
            )}
          </div>

          {probe && (
            probe.reachable ? (
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <Badge status="success">reachable</Badge>
                {(probe.tools ?? []).length === 0
                  ? <span style={{ color: "var(--text-secondary)", fontSize: "12px" }}>no tools advertised</span>
                  : (probe.tools ?? []).map((t) => <Badge key={t.name} status="neutral">{t.name}</Badge>)}
              </div>
            ) : (
              <span style={{ color: "var(--text-danger)", fontSize: "13px" }}>✗ {probe.error}</span>
            )
          )}
        </div>
      </Card>

      <div>
        <strong style={{ color: "var(--text-primary)", fontSize: "14px", display: "block", marginBottom: "8px" }}>
          MCP servers ({servers.length})
        </strong>
        {servers.length === 0 ? (
          <Empty>No MCP servers registered.</Empty>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {servers.map((s) => (
              <Card key={s.name}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <strong style={{ color: "var(--text-primary)", fontSize: "14px" }}>{s.name}</strong>
                  <Badge status={trustStatus(s.trust)}>{s.trust}</Badge>
                  <Badge status={s.enabled ? "success" : "neutral"}>{s.enabled ? "enabled" : "disabled"}</Badge>
                  <Badge status="neutral">{s.transport}</Badge>
                  <span style={{ flex: 1, display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    {s.grants.map((g) => <Badge key={g} status="warning">{g}</Badge>)}
                  </span>
                  <Button onClick={() => void onToggleEnabled(s)} disabled={busy}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <Power size={14} /> {s.enabled ? "Disable" : "Enable"}
                    </span>
                  </Button>
                  <Button onClick={() => setPendingDelete(s.name)} disabled={busy}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><Trash2 size={14} /> Remove</span>
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Remove MCP server "${pendingDelete ?? ""}"?`}
        message="Disconnects the server and unregisters all its tools from the live fleet, then deletes its YAML from workspace/mcp-servers.d/."
        confirmLabel="Remove"
        onConfirm={() => void doDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
