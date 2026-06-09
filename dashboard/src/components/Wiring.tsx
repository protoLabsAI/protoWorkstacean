import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Badge, Card, Empty, type Status } from "@protolabsai/ui";
import { Plus, Trash2, Cable } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog";
import {
  getRoutes,
  createRoute,
  deleteRoute,
  getAgentsRuntime,
  getAdminKey,
  setAdminKey,
  type RouteSummary,
} from "../lib/api";

/**
 * Wiring — the canvas's route authoring surface (ADR-0008 P2, WS-P2b).
 *
 * Lists the live `routes.d/` wiring ("when when.topic fires → dispatch
 * then.skill to then.agent") and authors new ones through the control-plane
 * write API (createRoute → command.route.upsert → registrar → hot-reload). A
 * route is one pub/sub hop — no payload transform, no logic (the D1/D5 line).
 * The /system canvas renders these same routes as edges (P2-b2).
 */

const inputStyle = {
  background: "var(--bg-default)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: "6px",
  padding: "8px 10px",
  fontSize: "13px",
  fontFamily: "var(--pl-font-mono)",
} as const;

export default function Wiring() {
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [agents, setAgents] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [key, setKey] = useState(getAdminKey());
  const [topic, setTopic] = useState("");
  const [skill, setSkill] = useState("");
  const [agent, setAgent] = useState(""); // "" → skill-resolved (no explicit target)
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [r, a] = await Promise.all([getRoutes(true), getAgentsRuntime(true)]);
      setRoutes(r.routes ?? []);
      setAgents((a.agents ?? []).map((x) => x.name).sort());
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  function saveKey(v: string) { setKey(v); setAdminKey(v); }

  // Default the route name from the skill (operator can override).
  function onSkillChange(v: string) {
    setSkill(v);
    if (!name || name === skill.toLowerCase().replace(/[^a-z0-9]+/g, "-")) {
      setName(v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
    }
  }

  async function onCreate() {
    if (!name.trim() || !topic.trim() || !skill.trim()) {
      setResult({ ok: false, msg: "name, when.topic and then.skill are required." });
      return;
    }
    const def = {
      name: name.trim(),
      when: { topic: topic.trim() },
      then: { skill: skill.trim(), ...(agent ? { agent } : {}) },
    };
    setBusy(true);
    const r = await createRoute(def);
    setBusy(false);
    if (r.ok) {
      setResult({ ok: true, msg: `Wired "${name}" — live within the hot-reload window (~5s).` });
      setTopic(""); setSkill(""); setAgent(""); setName("");
      setTimeout(() => void refresh(), 1500);
      void refresh();
    } else {
      setResult({ ok: false, msg: `${r.status}: ${(r.body?.error as string) ?? "create failed"}` });
    }
  }

  async function doDelete() {
    const target = pendingDelete;
    if (!target) return;
    setPendingDelete(null); setBusy(true);
    const r = await deleteRoute(target);
    setBusy(false);
    setResult(r.ok ? { ok: true, msg: `Removed "${target}".` } : { ok: false, msg: `${r.status}: ${(r.body?.error as string) ?? "delete failed"}` });
    if (r.ok) { setTimeout(() => void refresh(), 1500); void refresh(); }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px", maxWidth: "880px" }}>
      <div>
        <h2 style={{ color: "var(--text-primary)", marginBottom: "4px", display: "flex", alignItems: "center", gap: "8px" }}>
          <Cable size={18} /> Wiring
        </h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "13px" }}>
          Author routes — <em>when a bus topic fires, dispatch a skill to an agent</em>. One hop, no logic. Routes appear as edges on the <Link to="/system" style={{ color: "var(--accent-fg)" }}>canvas</Link> and dispatch live. Admin key required for writes.
        </p>
      </div>

      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <label style={{ color: "var(--text-secondary)", fontSize: "12px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Admin key</label>
          <input type="password" value={key} placeholder="WORKSTACEAN_API_KEY" onChange={(e) => saveKey(e.currentTarget.value)} style={{ ...inputStyle, fontFamily: "inherit", maxWidth: "360px" }} />
        </div>
      </Card>

      {/* Add a route */}
      <Card>
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <strong style={{ color: "var(--text-primary)", fontSize: "14px", display: "flex", alignItems: "center", gap: "6px" }}>
            <Plus size={14} /> New route
          </strong>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "var(--text-secondary)" }}>
              when.topic
              <input value={topic} placeholder="message.inbound.github.#" onChange={(e) => setTopic(e.currentTarget.value)} style={{ ...inputStyle, width: "100%" }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "var(--text-secondary)" }}>
              then.skill
              <input value={skill} placeholder="bug_triage" onChange={(e) => onSkillChange(e.currentTarget.value)} style={{ ...inputStyle, width: "100%" }} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "var(--text-secondary)" }}>
              then.agent <span style={{ opacity: 0.6 }}>(optional)</span>
              <select value={agent} onChange={(e) => setAgent(e.currentTarget.value)} style={{ ...inputStyle, fontFamily: "inherit", width: "100%" }}>
                <option value="">— skill-resolved —</option>
                {agents.map((a) => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "12px", color: "var(--text-secondary)" }}>
              name
              <input value={name} placeholder="triage-github-issues" onChange={(e) => setName(e.currentTarget.value)} style={{ ...inputStyle, fontFamily: "inherit", width: "100%" }} />
            </label>
          </div>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <Button variant="primary" onClick={() => void onCreate()} disabled={busy || !name.trim() || !topic.trim() || !skill.trim()}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}><Plus size={14} /> Wire</span>
            </Button>
            {result && (
              <span style={{ color: result.ok ? "var(--text-success)" : "var(--text-danger)", fontSize: "13px" }}>
                {result.ok ? "✓ " : "✗ "}{result.msg}
              </span>
            )}
          </div>
        </div>
      </Card>

      {loadError && (
        <Card><span style={{ color: "var(--text-danger)", fontSize: "13px" }}>✗ Failed to load routes: {loadError}</span></Card>
      )}

      {/* Live routes */}
      <div>
        <strong style={{ color: "var(--text-primary)", fontSize: "14px", display: "block", marginBottom: "8px" }}>Routes ({routes.length})</strong>
        {routes.length === 0 ? (
          <Empty>No routes wired yet.</Empty>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {routes.map((r) => (
              <Card key={r.name}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <strong style={{ color: "var(--text-primary)", fontSize: "14px" }}>{r.name}</strong>
                  {r.enabled === false && <Badge status={"neutral" as Status}>disabled</Badge>}
                  <span style={{ flex: 1, display: "inline-flex", alignItems: "center", gap: "6px", flexWrap: "wrap", fontFamily: "var(--pl-font-mono)", fontSize: "12px", color: "var(--text-secondary)" }}>
                    <Badge status={"info" as Status}>{r.when.topic}</Badge>
                    <span>→</span>
                    <span style={{ color: "var(--text-primary)" }}>{r.then.skill}</span>
                    {r.then.agent && <span>@ {r.then.agent}</span>}
                  </span>
                  <Button onClick={() => setPendingDelete(r.name)} disabled={busy}>
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
        title={`Remove route "${pendingDelete ?? ""}"?`}
        message="Unsubscribes the route from the live bus (~5s) and deletes its YAML from workspace/routes.d/."
        confirmLabel="Remove"
        onConfirm={() => void doDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
