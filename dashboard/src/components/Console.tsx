import { useState, useEffect, useCallback } from "react";
import { Button, Badge, Card, Empty, Divider, type Status } from "@protolabsai/ui";
import { RefreshCw, Plus, Trash2, CircleCheck, Pencil, X, Globe } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  getAgentsRuntime,
  testAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  getAgentDef,
  probeAgentCard,
  getAdminKey,
  setAdminKey,
  type AgentsRuntimeResponse,
} from "../lib/api";

// The Console is the fleet's WRITE surface (ADR-0004 P3) — distinct from the
// read-only debug panes. Brand-native via @protolabsai/ui + the --pl-* tokens.
// Drives the P2 control-plane API; mutations apply live via hot-reload (~5s).

type Agent = AgentsRuntimeResponse["agents"][number];

const TEMPLATE = `{
  "name": "my-agent",
  "role": "general",
  "model": "protolabs/reasoning",
  "systemPrompt": "What this agent does.",
  "tools": ["list_agents"],
  "skills": [
    { "name": "my_skill", "description": "what it handles", "keywords": [] }
  ]
}`;

function typeStatus(a: Agent): Status {
  if (a.pendingDiscovery) return "warning";
  if (a.type === "deep-agent") return "info";
  return "neutral";
}

export default function Console() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [key, setKey] = useState(getAdminKey());
  const [draft, setDraft] = useState(TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // agent name being edited; null = create mode
  const [probeUrl, setProbeUrl] = useState("");
  const [probe, setProbe] = useState<{ reachable: boolean; name?: string; skills: string[]; error?: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await getAgentsRuntime(true);
      setAgents(data.agents ?? []);
    } catch (err) {
      setResult({ ok: false, msg: `Failed to load fleet: ${err instanceof Error ? err.message : String(err)}` });
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  function saveKey(v: string) {
    setKey(v);
    setAdminKey(v);
  }

  function parseDraft(): unknown | null {
    try {
      return JSON.parse(draft);
    } catch (err) {
      setResult({ ok: false, msg: `Invalid JSON: ${err instanceof Error ? err.message : String(err)}` });
      return null;
    }
  }

  async function onValidate() {
    const def = parseDraft();
    if (def === null) return;
    setBusy(true);
    const r = await testAgent(def);
    setBusy(false);
    setResult(
      r.ok
        ? { ok: true, msg: `Valid — "${(r.body?.name as string) ?? "?"}" · skills: ${(r.body?.skills as string[] | undefined)?.join(", ") || "none"}` }
        : { ok: false, msg: `${r.status}: ${(r.body?.error as string) ?? "validation failed"}` },
    );
  }

  function resetForm() {
    setEditing(null);
    setDraft(TEMPLATE);
    setResult(null);
  }

  async function onSubmit() {
    const def = parseDraft();
    if (def === null) return;
    setBusy(true);
    const r = editing ? await updateAgent(editing, def) : await createAgent(def);
    setBusy(false);
    if (r.ok) {
      const verb = editing ? "Updated" : "Created";
      const who = editing ?? (r.body?.name as string) ?? "";
      setResult({ ok: true, msg: `${verb} "${who}" — live in ~5s via hot-reload.` });
      resetForm();
      setTimeout(() => void refresh(), 5500);
      void refresh();
    } else {
      setResult({ ok: false, msg: `${r.status}: ${(r.body?.error as string) ?? "save failed"}` });
    }
  }

  async function onEdit(name: string) {
    const r = await getAgentDef(name);
    if (r.ok && r.body?.def) {
      setEditing(name);
      setDraft(JSON.stringify(r.body.def, null, 2));
      setResult({ ok: true, msg: `Loaded "${name}" — edit below and Save.` });
    } else {
      setResult({ ok: false, msg: `${r.status}: ${(r.body?.error as string) ?? "load failed"}` });
    }
  }

  async function onProbe() {
    setBusy(true);
    setProbe(null);
    const r = await probeAgentCard(probeUrl.trim());
    setBusy(false);
    if (!r.ok) {
      setProbe({ reachable: false, skills: [], error: `${r.status}: ${(r.body?.error as string) ?? "probe failed"}` });
      return;
    }
    setProbe({
      reachable: Boolean(r.body?.reachable),
      name: r.body?.name as string | undefined,
      skills: (r.body?.skills as string[] | undefined) ?? [],
      error: r.body?.error as string | undefined,
    });
  }

  async function doDelete(name: string) {
    setPendingDelete(null);
    setBusy(true);
    const r = await deleteAgent(name);
    setBusy(false);
    setResult(
      r.ok
        ? { ok: true, msg: `Removed "${name}" — unregistered in ~5s.` }
        : { ok: false, msg: `${r.status}: ${(r.body?.error as string) ?? "delete failed"}` },
    );
    setTimeout(() => void refresh(), 5500);
  }

  const inputStyle = {
    background: "var(--bg-default)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-default)",
    borderRadius: "6px",
    padding: "8px 10px",
    fontSize: "13px",
    width: "100%",
    fontFamily: "var(--pl-font-mono)",
  } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px", maxWidth: "880px" }}>
      <div>
        <h2 style={{ color: "var(--text-primary)", marginBottom: "4px" }}>Console</h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
          The fleet's control plane. Changes apply live (~5s) — no restart. Admin key required for writes.
        </p>
      </div>

      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <label style={{ color: "var(--text-secondary)", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Admin key
          </label>
          <input
            type="password"
            value={key}
            placeholder="WORKSTACEAN_API_KEY"
            onChange={(e) => saveKey(e.currentTarget.value)}
            style={{ ...inputStyle, fontFamily: "inherit", maxWidth: "360px" }}
          />
        </div>
      </Card>

      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <strong style={{ color: "var(--text-primary)", fontSize: "14px" }}>
            {editing ? `Editing "${editing}"` : "New agent"}
          </strong>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.currentTarget.value)}
            spellCheck={false}
            rows={11}
            style={{ ...inputStyle, resize: "vertical" }}
          />
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <Button onClick={onValidate} disabled={busy}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><CircleCheck size={14} /> Validate</span>
            </Button>
            <Button variant="primary" onClick={onSubmit} disabled={busy}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                {editing ? <CircleCheck size={14} /> : <Plus size={14} />} {editing ? "Save" : "Create"}
              </span>
            </Button>
            {editing && (
              <Button onClick={resetForm} disabled={busy}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><X size={14} /> Cancel</span>
              </Button>
            )}
            {result && (
              <span style={{ color: result.ok ? "var(--text-success)" : "var(--text-danger)", fontSize: "13px" }}>
                {result.ok ? "✓ " : "✗ "}{result.msg}
              </span>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div>
            <strong style={{ color: "var(--text-primary)", fontSize: "14px" }}>Discover an A2A agent</strong>
            <p style={{ color: "var(--text-secondary)", fontSize: "12px", margin: "2px 0 0" }}>
              Probe a remote agent's card for reachability + skills before wiring it in.
            </p>
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <input
              value={probeUrl}
              placeholder="https://agent.example/ (base URL)"
              onChange={(e) => setProbeUrl(e.currentTarget.value)}
              style={{ ...inputStyle, fontFamily: "inherit", flex: 1 }}
            />
            <Button onClick={onProbe} disabled={busy || !probeUrl.trim()}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><Globe size={14} /> Probe</span>
            </Button>
          </div>
          {probe && (
            probe.reachable ? (
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                <Badge status="success">reachable</Badge>
                <strong style={{ color: "var(--text-primary)", fontSize: "13px" }}>{probe.name}</strong>
                {probe.skills.length === 0
                  ? <span style={{ color: "var(--text-secondary)", fontSize: "12px" }}>no skills advertised</span>
                  : probe.skills.map((s) => <Badge key={s} status="neutral">{s}</Badge>)}
              </div>
            ) : (
              <span style={{ color: "var(--text-danger)", fontSize: "13px" }}>✗ {probe.error}</span>
            )
          )}
        </div>
      </Card>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
          <strong style={{ color: "var(--text-primary)", fontSize: "14px" }}>Fleet ({agents.length})</strong>
          <Button onClick={() => void refresh()} disabled={busy}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><RefreshCw size={14} /> Refresh</span>
          </Button>
        </div>
        {agents.length === 0 ? (
          <Empty>No agents registered.</Empty>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {agents.map((a) => (
              <Card key={a.name}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <strong style={{ color: "var(--text-primary)", fontSize: "14px" }}>{a.name}</strong>
                  <Badge status={typeStatus(a)}>{a.pendingDiscovery ? "discovering" : a.type}</Badge>
                  <span style={{ flex: 1, display: "flex", gap: "6px", flexWrap: "wrap" }}>
                    {a.skills.map((s) => (
                      <Badge key={s} status="neutral">{s}</Badge>
                    ))}
                  </span>
                  {a.type === "deep-agent" && (
                    <>
                      <Button onClick={() => void onEdit(a.name)} disabled={busy}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><Pencil size={14} /> Edit</span>
                      </Button>
                      <Button onClick={() => setPendingDelete(a.name)} disabled={busy}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><Trash2 size={14} /> Remove</span>
                      </Button>
                    </>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
        <Divider />
        <p style={{ color: "var(--text-secondary)", fontSize: "12px" }}>
          In-process (deep-agent) agents are managed here. A2A agents are registered in <code>workspace/agents.yaml</code> (control-plane support coming).
        </p>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Remove "${pendingDelete ?? ""}"?`}
        message="Unregisters the agent from the live fleet (~5s) and deletes its YAML from workspace/agents/."
        confirmLabel="Remove"
        onConfirm={() => { if (pendingDelete) void doDelete(pendingDelete); }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
