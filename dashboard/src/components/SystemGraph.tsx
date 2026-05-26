/**
 * SystemGraph — live observability surface for the workstacean fleet.
 *
 * Phase 1: plugin↔topic graph from /api/bus/topology (shipped #555).
 * Phase 2 (this file): adds
 *   - Agent nodes from /api/agents/runtime, each showing current skill +
 *     last few tool calls inside the node (custom AgentNode component)
 *   - External service nodes (Discord, GitHub, Linear, LiteLLM gateway, npm)
 *     on the perimeter
 *   - Live edge animation on bus traffic via WS /api/bus/subscribe?topic=#
 *   - Agent state subscription on agent.runtime.activity.# so each agent's
 *     node pulses + shows real-time skill + tool-call history
 * Phase 3 (D3): clicking an edge opens MessageDrawer with the last
 *   TOPIC_HISTORY_CAP messages observed on that topic + jump-to-trace
 *   links into /trace?correlationId=… (D1).
 *
 * Layout: three concentric zones.
 *   center  — agents (the action)
 *   middle  — plugins (the routing layer)
 *   outer   — external services (where work eventually lands)
 */

import { useEffect, useMemo, useRef, useState } from "preact/compat";
import { ReactFlow, Background, Controls, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import AgentNode, { type AgentActivityState } from "./AgentNode.tsx";
import ServiceNode from "./ServiceNode.tsx";
import MessageDrawer, { type DrawerMessage } from "./MessageDrawer.tsx";
import QuinnVerdictCounters from "./QuinnVerdictCounters.tsx";

/** Ring-buffer cap for per-topic history shown in the edge drawer. */
const TOPIC_HISTORY_CAP = 20;

// ── Types ────────────────────────────────────────────────────────────────────

interface PluginTopologyEntry {
  name: string;
  description?: string;
  capabilities?: string[];
  publishes?: string[];
  subscribes?: string[];
}

interface AgentRuntimeEntry {
  name: string;
  type: string;
  skills: string[];
}

interface AgentActivityEvent {
  type: "skill.start" | "tool.call" | "skill.complete" | "skill.error";
  agentName: string;
  correlationId: string;
  timestamp: number;
  skill?: string;
  toolNames?: string[];
  resultPreview?: string;
  errorMessage?: string;
  durationMs?: number;
}

// ── External services ────────────────────────────────────────────────────────
// Hardcoded for now — the set of "things workstacean talks to but doesn't
// own". Could be derived from config later (each service is implicit in
// the plugin set today).
const SERVICES: Array<{ id: string; label: string; icon: string; description: string }> = [
  { id: "svc-discord", label: "Discord", icon: "💬", description: "Discord guild + DM transport" },
  { id: "svc-github", label: "GitHub", icon: "⌨", description: "Webhooks + REST/GraphQL API" },
  { id: "svc-linear", label: "Linear", icon: "📋", description: "Issue tracker + agent webhook" },
  { id: "svc-litellm", label: "LiteLLM", icon: "🧠", description: "Gateway for all agent LLM calls" },
  { id: "svc-npm", label: "npm", icon: "📦", description: "Published packages (protopatch, proto)" },
];

// Plugin → service edges. Static map describing which plugin owns which
// external integration. Used to draw the agent → plugin → service hops.
const PLUGIN_TO_SERVICES: Record<string, string[]> = {
  discord: ["svc-discord"],
  github: ["svc-github"],
  linear: ["svc-linear"],
  "linear-protomaker-bridge": ["svc-linear"],
  "pr-remediator": ["svc-github"],
  google: [],
  "agent-runtime": ["svc-litellm"],
  "skill-broker": ["svc-litellm"],
  "agent-fleet-health": [],
};

// ── Topic matching (AMQP-style, same as in-memory bus) ────────────────────────

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

// ── Layout ───────────────────────────────────────────────────────────────────
// Three concentric rings. Agents at center (smallest radius — they're the
// focal point); plugins in the middle; services on the outside.

function ringPos(idx: number, count: number, radius: number, cx = 500, cy = 380) {
  const angle = (idx / Math.max(count, 1)) * Math.PI * 2 - Math.PI / 2; // start at top
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
}

interface BuildArgs {
  plugins: PluginTopologyEntry[];
  agents: AgentRuntimeEntry[];
  agentActivity: Map<string, AgentActivityState>;
  activeEdges: Set<string>;
}

function buildGraph({ plugins, agents, agentActivity, activeEdges }: BuildArgs): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // 1. Agent nodes (inner ring)
  agents.forEach((a, idx) => {
    nodes.push({
      id: `agent-${a.name}`,
      type: "agent",
      position: ringPos(idx, agents.length, 180),
      data: { label: a.name, type: a.type, activity: agentActivity.get(a.name) },
    });
  });

  // 2. Plugin nodes (middle ring)
  plugins.forEach((p, idx) => {
    nodes.push({
      id: `plugin-${p.name}`,
      position: ringPos(idx, plugins.length, 380),
      data: { label: p.name },
      style: {
        background: "#161b22",
        color: "#e6edf3",
        border: "1px solid #30363d",
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 11,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
      },
    });
  });

  // 3. Service nodes (outer perimeter)
  SERVICES.forEach((s, idx) => {
    nodes.push({
      id: s.id,
      type: "service",
      position: ringPos(idx, SERVICES.length, 580),
      data: { label: s.label, icon: s.icon, description: s.description },
    });
  });

  // 4. Plugin → plugin edges (publisher → subscriber per topic)
  const seenEdges = new Set<string>();
  for (const publisher of plugins) {
    for (const topic of publisher.publishes ?? []) {
      for (const subscriber of plugins) {
        if (subscriber.name === publisher.name) continue;
        const matches = (subscriber.subscribes ?? []).some((p) => topicMatches(p, topic));
        if (!matches) continue;
        const key = `${publisher.name}->${subscriber.name}:${topic}`;
        if (seenEdges.has(key)) continue;
        seenEdges.add(key);
        const active = activeEdges.has(topic);
        edges.push({
          id: key,
          source: `plugin-${publisher.name}`,
          target: `plugin-${subscriber.name}`,
          label: topic,
          animated: active,
          style: { stroke: active ? "#3fb950" : "#21262d", strokeWidth: active ? 1.5 : 1 },
          labelStyle: { fill: "#6e7681", fontSize: 9, fontFamily: "ui-monospace, monospace" },
        });
      }
    }
  }

  // 5. Plugin → service edges (static, from the map)
  for (const [pluginName, serviceIds] of Object.entries(PLUGIN_TO_SERVICES)) {
    if (!plugins.find((p) => p.name === pluginName)) continue;
    for (const svcId of serviceIds) {
      edges.push({
        id: `${pluginName}->${svcId}`,
        source: `plugin-${pluginName}`,
        target: svcId,
        style: { stroke: "#58a6ff", strokeDasharray: "4 4", opacity: 0.5 },
      });
    }
  }

  // 6. Agent → agent-runtime / skill-broker plugin edges. Each agent's
  // dispatch flows through one of those plugins; render an edge so the
  // animation reaches the agent node when activity is live.
  for (const a of agents) {
    const hostPlugin = a.type === "a2a" ? "skill-broker" : "agent-runtime";
    if (!plugins.find((p) => p.name === hostPlugin)) continue;
    const live = agentActivity.get(a.name)?.status === "running";
    edges.push({
      id: `agent-${a.name}->${hostPlugin}`,
      source: `plugin-${hostPlugin}`,
      target: `agent-${a.name}`,
      animated: live,
      style: { stroke: live ? "#3fb950" : "#30363d", strokeWidth: live ? 2 : 1 },
    });
  }

  return { nodes, edges };
}

// ── Activity event → agent state machine ─────────────────────────────────────

function applyActivity(state: Map<string, AgentActivityState>, ev: AgentActivityEvent): Map<string, AgentActivityState> {
  const next = new Map(state);
  const prev = next.get(ev.agentName) ?? { status: "idle" as const, toolCalls: [] };

  switch (ev.type) {
    case "skill.start":
      next.set(ev.agentName, {
        status: "running",
        currentSkill: ev.skill,
        startedAt: ev.timestamp,
        toolCalls: [],
      });
      break;
    case "tool.call":
      next.set(ev.agentName, {
        ...prev,
        status: "running",
        toolCalls: [{ tools: ev.toolNames ?? [], timestamp: ev.timestamp }, ...prev.toolCalls].slice(0, 8),
      });
      break;
    case "skill.complete":
      next.set(ev.agentName, {
        ...prev,
        status: "completed",
        finishedAt: ev.timestamp,
        resultPreview: ev.resultPreview,
      });
      break;
    case "skill.error":
      next.set(ev.agentName, {
        ...prev,
        status: "error",
        finishedAt: ev.timestamp,
        errorMessage: ev.errorMessage,
      });
      break;
  }
  return next;
}

// ── Component ────────────────────────────────────────────────────────────────

const NODE_TYPES = { agent: AgentNode, service: ServiceNode };

export default function SystemGraph() {
  const [topology, setTopology] = useState<PluginTopologyEntry[] | null>(null);
  const [agents, setAgents] = useState<AgentRuntimeEntry[]>([]);
  const [agentActivity, setAgentActivity] = useState<Map<string, AgentActivityState>>(new Map());
  const [activeEdges, setActiveEdges] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Per-topic ring buffer of recent WS-observed messages. Lives in a ref
  // (not state) because every WS frame would otherwise re-trigger the
  // whole graph rebuild — we only need to re-render when the operator
  // actually opens the drawer for a specific topic.
  const topicHistoryRef = useRef<Map<string, DrawerMessage[]>>(new Map());
  const openTopicRef = useRef<string | null>(null);
  const [openTopic, _setOpenTopic] = useState<string | null>(null);
  // Wrapper keeps the ref + state in sync so the WS handler — which closes
  // over its initial state via the once-mount useEffect — can see the
  // latest open-drawer topic without re-subscribing on every change.
  const setOpenTopic = (t: string | null) => {
    openTopicRef.current = t;
    _setOpenTopic(t);
  };
  // Bumps when the open drawer's topic gets a new message — keeps the
  // drawer's view in sync without re-rendering the whole graph.
  const [drawerTick, setDrawerTick] = useState(0);

  // Initial fetch — topology + agents
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [topoR, agentsR] = await Promise.all([
          fetch("/api/bus/topology").then((r) => r.json()),
          fetch("/api/agents/runtime").then((r) => r.json()),
        ]);
        if (cancelled) return;
        if (!topoR.success) {
          setError(topoR.error ?? "topology fetch failed");
          return;
        }
        setTopology(topoR.data.plugins);
        setAgents(agentsR.success ? agentsR.data.agents : []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // WS subscription for live bus traffic
  // Subscribes to `#` (wildcard for everything). Bus traffic with a topic
  // we recognize as a topology edge pulses that edge for 1.5s.
  // agent.runtime.activity.* events also drive the agent node state.
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/api/bus/subscribe?topic=%23`;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const edgeTimers = new Map<string, ReturnType<typeof setTimeout>>();

    const connect = () => {
      ws = new WebSocket(url);
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as {
            topic?: string;
            payload?: unknown;
            correlationId?: string;
            timestamp?: number;
          };
          if (!msg.topic) return;
          // Agent activity → state machine
          if (msg.topic.startsWith("agent.runtime.activity.")) {
            const ev = msg.payload as AgentActivityEvent;
            setAgentActivity((cur) => applyActivity(cur, ev));
          }
          // Per-topic ring buffer for D3's edge drawer. Cap at TOPIC_HISTORY_CAP.
          const buf = topicHistoryRef.current.get(msg.topic) ?? [];
          buf.push({
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            topic: msg.topic,
            correlationId: msg.correlationId,
            timestamp: msg.timestamp ?? Date.now(),
            payload: msg.payload,
          });
          if (buf.length > TOPIC_HISTORY_CAP) buf.splice(0, buf.length - TOPIC_HISTORY_CAP);
          topicHistoryRef.current.set(msg.topic, buf);
          // If the drawer is open on this topic, force a re-render.
          if (msg.topic === openTopicRef.current) {
            setDrawerTick((t) => t + 1);
          }
          // Pulse the edge for any topic — phase 1 just animated each match for 1.5s
          setActiveEdges((cur) => new Set(cur).add(msg.topic!));
          if (edgeTimers.has(msg.topic)) clearTimeout(edgeTimers.get(msg.topic)!);
          edgeTimers.set(msg.topic, setTimeout(() => {
            setActiveEdges((cur) => {
              const next = new Set(cur);
              next.delete(msg.topic!);
              return next;
            });
            edgeTimers.delete(msg.topic!);
          }, 1500));
        } catch {
          // ignore malformed messages — the WS may emit framing data
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        // Backoff: reconnect after 2s
        retryTimer = setTimeout(connect, 2000);
      };
      ws.onerror = () => {
        // Closing here triggers onclose → reconnect
        ws?.close();
      };
    };
    connect();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      for (const t of edgeTimers.values()) clearTimeout(t);
      ws?.close();
    };
  }, []);

  const { nodes, edges } = useMemo(
    () => topology
      ? buildGraph({ plugins: topology, agents, agentActivity, activeEdges })
      : { nodes: [], edges: [] },
    [topology, agents, agentActivity, activeEdges],
  );

  if (error) {
    return <div style={{ padding: 24, color: "#f85149", fontFamily: "monospace" }}>topology error: {error}</div>;
  }
  if (!topology) {
    return <div style={{ padding: 24, color: "#8b949e" }}>loading topology…</div>;
  }

  const drawerMessages = useMemo(
    () => (openTopic ? topicHistoryRef.current.get(openTopic) ?? [] : []),
    // drawerTick is the WS-driven invalidation signal; openTopic re-runs when
    // the drawer switches topics.
    [openTopic, drawerTick],
  );

  return (
    <div style={{ width: "100%", height: "calc(100vh - 64px)", background: "#0d1117", position: "relative" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        minZoom={0.2}
        onEdgeClick={(_evt: unknown, edge: Edge) => {
          // Edges built from publisher → subscriber carry their topic as the
          // edge label. Static plugin → service edges have no topic — those
          // skip the drawer.
          const topic = typeof edge.label === "string" ? edge.label : null;
          if (topic) setOpenTopic(topic);
        }}
      >
        <Background color="#21262d" gap={16} />
        <Controls position="bottom-right" />
      </ReactFlow>
      <QuinnVerdictCounters />
      {openTopic && (
        <MessageDrawer
          topic={openTopic}
          messages={drawerMessages}
          onClose={() => setOpenTopic(null)}
        />
      )}
    </div>
  );
}
