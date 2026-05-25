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
  activity?: AgentActivityState;
}

const STATUS_COLOR: Record<AgentStatus, string> = {
  idle: "#30363d",
  running: "#3fb950",     // GitHub green
  completed: "#58a6ff",   // GitHub blue
  error: "#f85149",       // GitHub red
};

const TYPE_LABEL: Record<string, string> = {
  "deep-agent": "DeepAgent",
  a2a: "A2A",
  function: "function",
};

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

  return (
    <div
      style={{
        background: "#0d1117",
        color: "#e6edf3",
        border: `1px solid ${statusColor}`,
        borderRadius: 8,
        padding: 10,
        minWidth: 220,
        maxWidth: 280,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        fontSize: 11,
        boxShadow: status === "running" ? `0 0 12px ${statusColor}40` : "none",
      }}
    >
      <Handle type="target" position={Position.Left} style={{ background: "#30363d" }} />
      <Handle type="source" position={Position.Right} style={{ background: "#30363d" }} />

      {/* Header: name + type badge + status pill */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <strong style={{ fontSize: 13, color: "#e6edf3" }}>{data.label}</strong>
        <span
          style={{
            fontSize: 9,
            padding: "1px 5px",
            border: "1px solid #30363d",
            borderRadius: 3,
            color: "#8b949e",
          }}
        >
          {TYPE_LABEL[data.type] ?? data.type}
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

      {/* Current skill */}
      {activity?.currentSkill && (
        <div style={{ fontSize: 10, color: "#8b949e", marginBottom: 4 }}>
          skill: <span style={{ color: "#e6edf3" }}>{activity.currentSkill}</span>
          {activity.startedAt && status === "running" && (
            <span style={{ marginLeft: 6, color: "#6e7681" }}>· {relativeTime(activity.startedAt)}</span>
          )}
        </div>
      )}

      {/* Tool call history */}
      {activity && activity.toolCalls.length > 0 && (
        <div style={{ borderTop: "1px solid #21262d", paddingTop: 4, marginTop: 4 }}>
          {activity.toolCalls.slice(0, 4).map((call, idx) => (
            <div key={idx} style={{ fontSize: 10, color: "#8b949e", lineHeight: 1.4 }}>
              <span style={{ color: "#7ee787" }}>↳</span>{" "}
              <span style={{ color: "#e6edf3" }}>{call.tools.join(", ")}</span>
              <span style={{ marginLeft: 6, color: "#6e7681" }}>{relativeTime(call.timestamp)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Result preview / error */}
      {status === "completed" && activity?.resultPreview && (
        <div
          style={{
            borderTop: "1px solid #21262d",
            paddingTop: 4,
            marginTop: 4,
            fontSize: 10,
            color: "#8b949e",
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
