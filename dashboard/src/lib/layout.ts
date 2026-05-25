/**
 * Dagre-based force-directed layout for the SystemGraph.
 *
 * Concentric rings broke down past ~30 nodes — labels stacked, edges
 * crossed, the focal-point hierarchy turned into spaghetti. Dagre gives us
 * a directed layered layout: agents end up clustered near the dispatcher
 * they route through, services drift to the perimeter naturally, and the
 * "where does this message flow" question is answered by following edges
 * left-to-right instead of squinting at angular positions.
 *
 * The graph is sparse enough (~50 nodes / ~150 edges in worst case today)
 * that dagre's O(V*E) ranking algorithm finishes in single-digit ms — safe
 * to re-run on every WS topology refresh.
 */

import dagre from "dagre";
import type { Node, Edge } from "@xyflow/react";

const DEFAULT_NODE_WIDTH = 160;
const DEFAULT_NODE_HEIGHT = 60;
const AGENT_NODE_WIDTH = 200;
const AGENT_NODE_HEIGHT = 100;
const SERVICE_NODE_WIDTH = 140;
const SERVICE_NODE_HEIGHT = 70;

export type LayoutDirection = "LR" | "TB";

export interface LayoutOptions {
  direction?: LayoutDirection;
  /** Pixel separation between sibling nodes in the same rank. Lower = denser. */
  nodeSep?: number;
  /** Pixel separation between ranks. Lower = shorter graph. */
  rankSep?: number;
}

/**
 * Lay out a node + edge set with dagre. Mutates positions on a fresh copy
 * — input nodes are not modified. Node `type` is used to pick a sensible
 * width/height (agent + service nodes are larger than plain plugin pills).
 */
export function dagreLayout(
  nodes: Node[],
  edges: Edge[],
  opts: LayoutOptions = {},
): { nodes: Node[]; edges: Edge[] } {
  const direction: LayoutDirection = opts.direction ?? "LR";
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: direction,
    nodesep: opts.nodeSep ?? 40,
    ranksep: opts.rankSep ?? 120,
    marginx: 40,
    marginy: 40,
  });

  for (const n of nodes) {
    const { width, height } = sizeFor(n);
    g.setNode(n.id, { width, height });
  }
  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  const laidOut: Node[] = nodes.map(n => {
    const { x, y } = g.node(n.id);
    const { width, height } = sizeFor(n);
    return {
      ...n,
      // dagre's coordinates are centered on the node; React Flow expects
      // top-left, so shift by half the dimensions.
      position: { x: x - width / 2, y: y - height / 2 },
    };
  });

  return { nodes: laidOut, edges };
}

function sizeFor(n: Node): { width: number; height: number } {
  switch (n.type) {
    case "agent":
      return { width: AGENT_NODE_WIDTH, height: AGENT_NODE_HEIGHT };
    case "service":
      return { width: SERVICE_NODE_WIDTH, height: SERVICE_NODE_HEIGHT };
    default:
      return { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
  }
}
