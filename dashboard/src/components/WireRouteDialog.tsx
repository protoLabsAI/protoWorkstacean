/**
 * WireRouteDialog — the drag-to-wire form (ADR-0008 P2-b2).
 *
 * Opened when an operator drags a connection onto an agent node on the canvas.
 * The target agent is fixed (what you dropped on); the operator supplies the
 * trigger topic + skill, and we POST a route via the control-plane API (the
 * same path the Wiring panel uses). A route is one hop, no logic (D1/D5).
 */

import { useEffect, useState } from "react";
import { getAdminKey, setAdminKey, type WriteResult } from "../lib/api";

interface Props {
  /** The target agent (then.agent) — fixed by the drop. */
  agent: string;
  onClose: () => void;
  onCreate: (def: unknown) => Promise<WriteResult>;
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

const kebab = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export default function WireRouteDialog({ agent, onClose, onCreate }: Props) {
  const [key, setKey] = useState(getAdminKey());
  const [topic, setTopic] = useState("");
  const [skill, setSkill] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function onSkill(v: string) {
    setSkill(v);
    if (!name || name === kebab(skill)) setName(kebab(v));
  }

  async function submit() {
    if (!topic.trim() || !skill.trim() || !name.trim()) {
      setResult({ ok: false, msg: "topic, skill and name are required." });
      return;
    }
    setBusy(true);
    const r = await onCreate({ name: name.trim(), when: { topic: topic.trim() }, then: { skill: skill.trim(), agent } });
    setBusy(false);
    if (r.ok) {
      setResult({ ok: true, msg: "Wired — live within the hot-reload window." });
      setTimeout(onClose, 900);
    } else {
      setResult({ ok: false, msg: `${r.status}: ${(r.body?.error as string) ?? "create failed"}` });
    }
  }

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200 }} />
      <div
        role="dialog"
        aria-label={`Wire a route to ${agent}`}
        style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          width: 420, maxWidth: "92vw", background: "var(--bg-canvas)", border: "1px solid var(--border-default)",
          borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.5)", zIndex: 201, padding: 18,
          fontFamily: "ui-monospace, SFMono-Regular, monospace", color: "var(--text-primary)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <strong style={{ fontSize: 14 }}>Wire a route → <span style={{ color: "var(--accent-fg)" }}>{agent}</span></strong>
          <button onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 20, cursor: "pointer" }}>×</button>
        </div>
        <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: "0 0 12px" }}>
          When a bus topic fires, dispatch a skill to {agent}. One hop, no logic.
        </p>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: 4 }}>
            admin key
            <input type="password" value={key} placeholder="WORKSTACEAN_API_KEY" onChange={(e) => { setKey(e.currentTarget.value); setAdminKey(e.currentTarget.value); }} style={{ ...inputStyle, fontFamily: "inherit" }} />
          </label>
          <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: 4 }}>
            when.topic
            <input value={topic} placeholder="message.inbound.github.#" onChange={(e) => setTopic(e.currentTarget.value)} style={inputStyle} />
          </label>
          <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: 4 }}>
            then.skill
            <input value={skill} placeholder="bug_triage" onChange={(e) => onSkill(e.currentTarget.value)} style={inputStyle} />
          </label>
          <label style={{ fontSize: 12, color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: 4 }}>
            name
            <input value={name} placeholder="triage-github-issues" onChange={(e) => setName(e.currentTarget.value)} style={{ ...inputStyle, fontFamily: "inherit" }} />
          </label>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
          <button
            onClick={() => void submit()}
            disabled={busy || !topic.trim() || !skill.trim() || !name.trim()}
            style={{ background: "var(--accent-emphasis)", color: "#fff", border: "none", borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "pointer", opacity: busy ? 0.6 : 1 }}
          >
            Wire
          </button>
          <button onClick={onClose} style={{ background: "transparent", color: "var(--text-secondary)", border: "1px solid var(--border-default)", borderRadius: 6, padding: "7px 14px", fontSize: 13, cursor: "pointer" }}>Cancel</button>
          {result && <span style={{ fontSize: 12, color: result.ok ? "var(--text-success)" : "var(--text-danger)" }}>{result.ok ? "✓ " : "✗ "}{result.msg}</span>}
        </div>
      </div>
    </>
  );
}
