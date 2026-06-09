/**
 * AgentNode — custom React Flow node for in-process / A2A / function agents.
 *
 * Renders a card with: agent name, type badge, status pill, current skill
 * (when running), and the last 3 tool calls with timestamps. State is owned
 * by SystemGraph.tsx and passed via `data.activity`.
 */

import { Handle, Position } from "@xyflow/react";

type AgentStatus = "idle" | "running" | "completed" | "error";

export interface AgentActivityState {
  status: AgentStatus;
  currentSkill?: string;
  /** ms since epoch — used to compute the "Ns ago" labels in the activity log */
  startedAt?: number;
  finishedAt?: number;
  /** Most-recent first, capped to ~5 entries by the parent */
  toolCalls: Array<{ tools: string[]; timestamp: number }>;
  resultPreview?: string;
  errorMessage?: string;
}

export interface AgentNodeData {
  label: string;
  type: string; // "deep-agent" | "a2a" | "function"
  /** A2A only: endpoint host[:port] (e.g. "roxy:7870") — where the remote node lives. */
  host?: string;
  activity?: AgentActivityState;
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: "var(--border-default)",
  running: "var(--text-success)",     // GitHub green
  completed: "var(--accent-fg)",   // GitHub blue
  error: "var(--text-danger)",       // GitHub red
};

/** Tier tag (ADR-0008): in-process `builtin` vs distributed `a2a`. */
function tierLabel(type: string): string {
  return type === "a2a" ? "a2a" : "builtin";
}

function relativeTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 1000) return "just now";
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

export default function AgentNode({ data }: { data: AgentNodeData }) {
  const activity = data.activity;
  const status: AgentStatus = activity?.status ?? "idle";
  const statusColor = STATUS_COLOR[status];
  // Remote (A2A) nodes get a dashed border — the same "lives elsewhere" idiom
  // the graph already uses for service + api-route nodes — so tier reads at a
  // glance even when idle.
  const isRemote = data.type === "a2a";

  return (
    <div
      style={{
        background: "var(--bg-canvas)",
        color: "var(--text-primary)",
        border: `1px ${isRemote ? "dashed" : "solid"} ${statusColor}`,
        borderRadius: 8,
        padding: 10,
        minWidth: 220,
        maxWidth: 280,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        fontSize: 11,
        boxShadow: status === "running" ? `0 0 12px ${statusColor}40` : "none",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "var(--border-default)" }} />
      <Handle type="source" position={Position.Right} style={{ background: "var(--border-default)" }} />

      {/* Header: name + type badge + status pill */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <strong style={{ fontSize: 13, color: "var(--text-primary)" }}>{data.label}</strong>
        <span
          style={{
            fontSize: 9,
            padding: "1px 5px",
            border: `1px ${isRemote ? "dashed" : "solid"} var(--border-default)`,
            borderRadius: 3,
            color: isRemote ? "var(--accent-fg)" : "var(--text-secondary)",
          }}
        >
          {tierLabel(data.type)}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4 }}>
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              background: statusColor,
              boxShadow: status === "running" ? `0 0 4px ${statusColor}` : "none",
            }}
          />
          <span style={{ fontSize: 10, color: statusColor }}>{status}</span>
        </span>
      </div>

      {/* Remote host — where the distributed A2A node lives */}
      {isRemote && data.host && (
        <div style={{ fontSize: 10, color: "var(--text-secondary)", marginBottom: 4 }}>
          <span style={{ color: "var(--accent-fg)" }}>⤳</span> {data.host}
        </div>
      )}

      {/* Current skill */}
      {activity?.currentSkill && (
        <div style={{ fontSize: 10, color: "var(--text-secondary)", marginBottom: 4 }}>
          skill: <span style={{ color: "var(--text-primary)" }}>{activity.currentSkill}</span>
          {activity.startedAt && status === "running" && (
            <span style={{ marginLeft: 6, color: "var(--text-secondary)" }}>· {relativeTime(activity.startedAt)}</span>
          )}
        </div>
      )}

      {/* Tool call history */}
      {activity && activity.toolCalls.length > 0 && (
        <div style={{ borderTop: "1px solid var(--border-muted)", paddingTop: 4, marginTop: 4 }}>
          {activity.toolCalls.slice(0, 4).map((call, idx) => (
            <div key={idx} style={{ fontSize: 10, color: "var(--text-secondary)", lineHeight: 1.4 }}>
              <span style={{ color: "var(--text-success)" }}>↳</span>{" "}
              <span style={{ color: "var(--text-primary)" }}>{call.tools.join(", ")}</span>
              <span style={{ marginLeft: 6, color: "var(--text-secondary)" }}>{relativeTime(call.timestamp)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Result preview / error */}
      {status === "completed" && activity?.resultPreview && (
        <div
          style={{
            borderTop: "1px solid var(--border-muted)",
            paddingTop: 4,
            marginTop: 4,
            fontSize: 10,
            color: "var(--text-secondary)",
            fontStyle: "italic",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={activity.resultPreview}
        >
          {activity.resultPreview}
        </div>
      )}
      {status === "error" && activity?.errorMessage && (
        <div
          style={{
            borderTop: `1px solid ${STATUS_COLOR.error}40`,
            paddingTop: 4,
            marginTop: 4,
            fontSize: 10,
            color: STATUS_COLOR.error,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={activity.errorMessage}
        >
          ⚠ {activity.errorMessage}
        </div>
      )}
    </div>
  );
}
