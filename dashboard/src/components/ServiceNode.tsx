/**
 * ServiceNode — external service that the workstacean fleet talks to.
 * Lives on the perimeter of the graph: Discord / GitHub / Linear / LiteLLM
 * gateway / npm. Mostly decorative — the agents are the action — but having
 * them on the graph closes the visual loop on "what's touching what".
 */

import { Handle, Position } from "@xyflow/react";

export interface ServiceNodeData {
  label: string;
  icon?: string; // single emoji or glyph; rendered before the label
  description?: string;
}

export default function ServiceNode({ data }: { data: ServiceNodeData }) {
  return (
    <div
      style={{
        background: "#161b22",
        color: "#e6edf3",
        border: "1px dashed #58a6ff",
        borderRadius: 999,
        padding: "6px 14px",
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
        fontSize: 11,
        opacity: 0.85,
        minWidth: 100,
        textAlign: "center",
      }}
      title={data.description}
    >
      <Handle type="target" position={Position.Left} style={{ background: "#58a6ff", opacity: 0.4 }} />
      <Handle type="source" position={Position.Right} style={{ background: "#58a6ff", opacity: 0.4 }} />
      {data.icon ? <span style={{ marginRight: 4 }}>{data.icon}</span> : null}
      <span>{data.label}</span>
    </div>
  );
}
