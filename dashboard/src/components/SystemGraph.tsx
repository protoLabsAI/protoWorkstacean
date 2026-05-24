/**
 * SystemGraph — live plugin↔topic graph for the workstacean bus.
 *
 * v1 (this file): fetches /api/bus/topology on mount, renders one node per
 * plugin, one edge per publish→subscribe topic pair. Layout is a simple
 * deterministic ring so the graph stays readable without a heavy layout
 * engine; React Flow's `<Background />` + `<Controls />` give pan/zoom.
 *
 * Phase 2 (next PR): subscribe to WS /api/bus/subscribe?topic=# and animate
 * edges as messages flow. Custom AgentNode components for in-process agents
 * showing current skill + recent tool calls — driven by an
 * `agent.runtime.activity` bus topic the SkillDispatcher will publish.
 */

import { useEffect, useMemo, useState } from "preact/compat";
import {
  ReactFlow,
  Background,
  Controls,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

interface PluginTopologyEntry {
  name: string;
  description?: string;
  capabilities?: string[];
  publishes?: string[];
  subscribes?: string[];
}

interface TopologyResponse {
  success: boolean;
  data?: { plugins: PluginTopologyEntry[] };
  error?: string;
}

/** Deterministic ring layout — index → (x, y). */
function ringPosition(idx: number, count: number, radius = 320, cx = 400, cy = 320): { x: number; y: number } {
  const angle = (idx / Math.max(count, 1)) * Math.PI * 2;
  return {
    x: cx + Math.cos(angle) * radius,
    y: cy + Math.sin(angle) * radius,
  };
}

/**
 * Build React Flow nodes + edges from a topology document. Each plugin is a
 * node; each (publisher, subscriber) pair sharing a topic is an edge labeled
 * with the topic name. Pattern-based subscriptions ("#", "topic.#") match
 * any publisher's topic that fits the pattern.
 */
function buildGraph(plugins: PluginTopologyEntry[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = plugins.map((p, idx) => ({
    id: p.name,
    position: ringPosition(idx, plugins.length),
    data: {
      label: p.name,
    },
    style: {
      background: "#161b22",
      color: "#e6edf3",
      border: "1px solid #30363d",
      borderRadius: 6,
      padding: "8px 12px",
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, monospace",
    },
  }));

  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const publisher of plugins) {
    for (const topic of publisher.publishes ?? []) {
      for (const subscriber of plugins) {
        if (subscriber.name === publisher.name) continue;
        const matches = (subscriber.subscribes ?? []).some((pattern) => topicMatches(pattern, topic));
        if (!matches) continue;
        const key = `${publisher.name}->${subscriber.name}:${topic}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          id: key,
          source: publisher.name,
          target: subscriber.name,
          label: topic,
          style: { stroke: "#30363d" },
          labelStyle: { fill: "#8b949e", fontSize: 10, fontFamily: "ui-monospace, monospace" },
        });
      }
    }
  }

  return { nodes, edges };
}

/**
 * AMQP-style topic matching: `#` matches anything; `*.foo` matches one
 * segment; `foo.#` matches `foo` and `foo.anything`. Mirrors the matcher
 * the in-memory bus uses so the graph reflects actual delivery.
 */
function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === "#" || pattern === topic) return true;
  const re = new RegExp(
    "^"
    + pattern
        .split(".")
        .map((seg) => seg === "#" ? ".*" : seg === "*" ? "[^.]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\.")
    + "$",
  );
  return re.test(topic);
}

export default function SystemGraph() {
  const [topology, setTopology] = useState<PluginTopologyEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const resp = await fetch("/api/bus/topology");
        const body = (await resp.json()) as TopologyResponse;
        if (cancelled) return;
        if (!body.success || !body.data) {
          setError(body.error ?? "topology fetch failed");
          return;
        }
        setTopology(body.data.plugins);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  const { nodes, edges } = useMemo(
    () => topology ? buildGraph(topology) : { nodes: [], edges: [] },
    [topology],
  );

  if (error) {
    return (
      <div style={{ padding: 24, color: "#f85149", fontFamily: "monospace" }}>
        topology error: {error}
      </div>
    );
  }
  if (!topology) {
    return <div style={{ padding: 24, color: "#8b949e" }}>loading topology…</div>;
  }

  return (
    <div style={{ width: "100%", height: "calc(100vh - 64px)", background: "#0d1117" }}>
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background color="#21262d" gap={16} />
        <Controls position="bottom-right" />
      </ReactFlow>
    </div>
  );
}
