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
 * O-4: synthesize an `api-routes` pseudo-publisher node for topics that
 *   some plugin subscribes to but no Plugin declares as published —
 *   typically HTTP-route-fired (src/api/*) signals. Without this, an
 *   entire class of bus traffic is invisible in /system.
 *
 * Layout: three concentric zones.
 *   center  — agents (the action)
 *   middle  — plugins (the routing layer)
 *   outer   — external services (where work eventually lands)
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ReactFlow, Background, Controls, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import AgentNode, { type AgentActivityState } from "./AgentNode.tsx";
import ServiceNode from "./ServiceNode.tsx";
import MessageDrawer, { type DrawerMessage } from "./MessageDrawer.tsx";
import NodeInspector, { type InspectorNode } from "./NodeInspector.tsx";
import QuinnVerdictCounters from "./QuinnVerdictCounters.tsx";
import LatencyHistogram from "./LatencyHistogram.tsx";
import { architecturalLayout } from "../lib/layout.ts";
import { applyFlowDispatch, type FlowDispatchItem } from "../lib/flow-dispatch.ts";

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
  /** A2A only: endpoint host[:port] from /api/agents/runtime. */
  host?: string;
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
// Architectural-column layout (see ../lib/layout.ts). The protoWorkstacean
// spine is trigger → router → dispatcher → executor → agent → external, so
// the graph reads strictly left-to-right along that spine. Concentric rings
// (#555) and force-directed dagre both produced technically-correct but
// noisy placements that didn't surface the architecture; this version
// hand-classifies every plugin into a named column and stacks vertically
// within the column.
//
// PLACEHOLDER_POS is what buildGraph stamps on every node; architecturalLayout
// overwrites all positions at the end so the placeholders never reach React Flow.
const PLACEHOLDER_POS = { x: 0, y: 0 };

interface BuildArgs {
  plugins: PluginTopologyEntry[];
  agents: AgentRuntimeEntry[];
  agentActivity: Map<string, AgentActivityState>;
  activeEdges: Set<string>;
  /** Agent names with a live dispatch, folded from flow.item.* (WS-3b). */
  inFlight: Set<string>;
}

function buildGraph({ plugins, agents, agentActivity, activeEdges, inFlight }: BuildArgs): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  // 1. Agent nodes (inner ring)
  agents.forEach((a, idx) => {
    nodes.push({
      id: `agent-${a.name}`,
      type: "agent",
      position: PLACEHOLDER_POS,
      data: { label: a.name, type: a.type, host: a.host, activity: agentActivity.get(a.name) },
    });
  });

  // 2. Plugin nodes (middle ring)
  plugins.forEach((p, idx) => {
    nodes.push({
      id: `plugin-${p.name}`,
      position: PLACEHOLDER_POS,
      data: { label: p.name },
      style: {
        background: "var(--bg-default)",
        color: "var(--text-primary)",
        border: "1px solid var(--border-default)",
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
      position: PLACEHOLDER_POS,
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
          style: { stroke: active ? "var(--text-success)" : "var(--border-muted)", strokeWidth: active ? 1.5 : 1 },
          labelStyle: { fill: "var(--text-secondary)", fontSize: 9, fontFamily: "ui-monospace, monospace" },
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
        style: { stroke: "var(--accent-fg)", strokeDasharray: "4 4", opacity: 0.5 },
      });
    }
  }

  // 6. Agent → agent-runtime / skill-broker plugin edges. Each agent's
  // dispatch flows through one of those plugins; the edge animates while a
  // dispatch to that agent is in-flight. The live signal is flow.item.* (the
  // hub's authoritative dispatch lifecycle), so a dispatch out to a distributed
  // A2A agent animates exactly like an in-process one — both flow through the
  // hub. A2A edges are dashed, matching the "lives elsewhere" idiom.
  for (const a of agents) {
    const hostPlugin = a.type === "a2a" ? "skill-broker" : "agent-runtime";
    if (!plugins.find((p) => p.name === hostPlugin)) continue;
    const live = inFlight.has(a.name);
    const remote = a.type === "a2a";
    edges.push({
      id: `agent-${a.name}->${hostPlugin}`,
      source: `plugin-${hostPlugin}`,
      target: `agent-${a.name}`,
      animated: live,
      style: {
        stroke: live ? "var(--text-success)" : "var(--border-default)",
        strokeWidth: live ? 2 : 1,
        strokeDasharray: remote ? "5 4" : undefined,
      },
    });
  }

  // 7. Orphan-publisher synthesis. Topics that some plugin subscribes to
  // but no plugin publishes are typically fired from HTTP route handlers
  // (src/api/*.ts) — not Plugin instances, so they're invisible in
  // /api/bus/topology. Without surfacing them, an entire class of bus
  // traffic has no edge in /system (e.g. quinn.review.submitted today).
  //
  // We collect the orphan literal topics here, draw a single synthetic
  // `api-routes` pseudo-publisher node, and wire one edge per
  // (topic, subscriber). The edge inherits the same active-animation
  // behavior as the plugin↔plugin edges, so when an API route fires the
  // topic the edge pulses too.
  //
  // Wildcard subscriptions ("#", "foo.#", "foo.*") are skipped — they
  // match by-design and a wildcard with no matching publisher isn't
  // necessarily an orphan, just a permissive listener.
  const publishedTopics = new Set<string>();
  for (const plugin of plugins) {
    for (const topic of plugin.publishes ?? []) publishedTopics.add(topic);
  }
  const orphanEdges: Array<{ topic: string; subscriberName: string }> = [];
  for (const subscriber of plugins) {
    for (const subPattern of subscriber.subscribes ?? []) {
      if (subPattern.includes("#") || subPattern.includes("*")) continue;
      const matched = [...publishedTopics].some(
        (p) => p === subPattern || topicMatches(p, subPattern),
      );
      if (!matched) {
        orphanEdges.push({ topic: subPattern, subscriberName: subscriber.name });
      }
    }
  }
  if (orphanEdges.length > 0) {
    nodes.push({
      id: "api-routes",
      position: PLACEHOLDER_POS,
      data: { label: "api-routes" },
      style: {
        background: "var(--bg-default)",
        color: "var(--text-warning)",
        border: "1px dashed var(--text-warning)",
        borderRadius: 6,
        padding: "6px 10px",
        fontSize: 11,
        fontFamily: "ui-monospace, SFMono-Regular, monospace",
      },
    });
    for (const { topic, subscriberName } of orphanEdges) {
      const active = activeEdges.has(topic);
      edges.push({
        id: `api-routes->${subscriberName}:${topic}`,
        source: "api-routes",
        target: `plugin-${subscriberName}`,
        label: topic,
        animated: active,
        style: {
          stroke: active ? "var(--text-success)" : "var(--text-warning)",
          strokeWidth: active ? 1.5 : 1,
          strokeDasharray: active ? undefined : "4 4",
          opacity: active ? 1 : 0.7,
        },
        labelStyle: { fill: "var(--text-warning)", fontSize: 9, fontFamily: "ui-monospace, monospace" },
      });
    }
  }

  return architecturalLayout(nodes, edges);
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
  // Agent names with a live dispatch, folded from flow.item.* (WS-3b). Drives
  // the host→agent edge animation uniformly across builtin + a2a tiers.
  const [inFlight, setInFlight] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Agent name whose inspector is open (WS-3c). Mutually exclusive with the
  // edge MessageDrawer.
  const [openNode, setOpenNode] = useState<string | null>(null);
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
          // Agent activity → state machine (in-process node internals: skill + tools)
          if (msg.topic.startsWith("agent.runtime.activity.")) {
            const ev = msg.payload as AgentActivityEvent;
            setAgentActivity((cur) => applyActivity(cur, ev));
          }
          // Dispatch lifecycle → in-flight set (the authoritative, tier-agnostic
          // signal driving the host→agent edge animation).
          if (msg.topic.startsWith("flow.item.")) {
            const topic = msg.topic;
            const item = msg.payload as FlowDispatchItem;
            setInFlight((cur) => applyFlowDispatch(cur, topic, item));
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
      ? buildGraph({ plugins: topology, agents, agentActivity, activeEdges, inFlight })
      : { nodes: [], edges: [] },
    [topology, agents, agentActivity, activeEdges, inFlight],
  );

  // ALL hooks must run before any conditional return (Rules of Hooks). This
  // useMemo previously sat AFTER the error/loading early-returns: the first
  // render (topology null) skipped it, then once topology loaded the return was
  // skipped and the hook ran — a changing hook count that crashed the whole
  // /system view (and, with no ErrorBoundary, blanked the app). Keep it here.
  const drawerMessages = useMemo(
    () => (openTopic ? topicHistoryRef.current.get(openTopic) ?? [] : []),
    // drawerTick is the WS-driven invalidation signal; openTopic re-runs when
    // the drawer switches topics.
    [openTopic, drawerTick],
  );

  if (error) {
    return <div style={{ padding: 24, color: "var(--text-danger)", fontFamily: "monospace" }}>topology error: {error}</div>;
  }
  if (!topology) {
    return <div style={{ padding: 24, color: "var(--text-secondary)" }}>loading topology…</div>;
  }

  const inspectorAgent = openNode ? agents.find((a) => a.name === openNode) : undefined;
  const inspectorNode: InspectorNode | null = openNode
    ? { name: openNode, type: inspectorAgent?.type ?? "deep-agent", host: inspectorAgent?.host, activity: agentActivity.get(openNode) }
    : null;

  return (
    <div style={{ width: "100%", height: "calc(100vh - 64px)", background: "var(--bg-canvas)", position: "relative" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        minZoom={0.2}
        onNodeClick={(_evt: unknown, node: Node) => {
          // Agent nodes (id `agent-<name>`) open the in-context inspector
          // (tier, host, live activity, last flow item, links out to
          // /executions + /trace). Plugin/service/api-route nodes have no
          // inspector — those clicks are inert.
          if (node.id.startsWith("agent-")) {
            setOpenNode(node.id.slice("agent-".length));
            setOpenTopic(null); // inspector + edge drawer are mutually exclusive
          }
        }}
        onEdgeClick={(_evt: unknown, edge: Edge) => {
          // Edges built from publisher → subscriber carry their topic as the
          // edge label. Static plugin → service edges have no topic — those
          // skip the drawer.
          const topic = typeof edge.label === "string" ? edge.label : null;
          if (topic) {
            setOpenTopic(topic);
            setOpenNode(null);
          }
        }}
      >
        <Background color="var(--bg-subtle)" gap={16} />
        <Controls position="bottom-right" />
      </ReactFlow>
      <QuinnVerdictCounters />
      <LatencyHistogram />
      {openTopic && (
        <MessageDrawer
          topic={openTopic}
          messages={drawerMessages}
          onClose={() => setOpenTopic(null)}
        />
      )}
      {inspectorNode && (
        <NodeInspector node={inspectorNode} onClose={() => setOpenNode(null)} />
      )}
    </div>
  );
}
