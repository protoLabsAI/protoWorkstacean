/**
 * Architectural-column layout for the SystemGraph.
 *
 * The protoWorkstacean spine (per CLAUDE.md) is
 *
 *   trigger → router → dispatcher → executor → agent → external
 *
 * The concentric-ring layout that #555 shipped didn't surface that
 * shape, and a generic force-directed algorithm (dagre, elk) wouldn't
 * either — both produce technically-correct-but-noisy placements that
 * obscure the architecture.
 *
 * This layout hand-classifies each node into one of eight columns and
 * stacks vertically within the column. The result reads strictly
 * left-to-right along the spine: system internals on the far left,
 * external services on the far right, agents one column inside that.
 *
 * Plugins are matched by name (per-name override table). Anything
 * unrecognized falls into the `misc` column so it's visible without a
 * code change — adding a real classification is then a one-line append
 * to PLUGIN_COLUMN_OVERRIDES.
 */

import type { Node, Edge } from "@xyflow/react";

export const COLUMNS = [
  "system",     // debug, logger, recorders
  "surface",    // inbound surface plugins + the api-routes pseudo-node
  "bridge",     // cross-surface translators (linear→protomaker, etc.)
  "router",     // the unique router
  "dispatcher", // skill-dispatcher + sibling intercept layer
  "executor",   // skill-executor registrars + skill-side plugins
  "agent",      // agents from /api/agents/runtime
  "service",    // external services on the perimeter
  "misc",       // unclassified — visible but not laid out architecturally
] as const;

export type Column = (typeof COLUMNS)[number];

/** Hard overrides for plugin names to architectural column. */
const PLUGIN_COLUMN_OVERRIDES: Record<string, Column> = {
  "router":                                  "router",
  "skill-dispatcher":                        "dispatcher",
  "skill-ab-test":                           "dispatcher",
  "agent-runtime":                           "executor",
  "skill-broker":                            "executor",
  "alert-skill-executor":                    "executor",
  "ceremony-skill-executor":                 "executor",
  "pr-remediator-skill-executor":            "executor",
  "clawpatch-cache-cleanup-skill-executor":  "executor",
  "quinn-review-notifier":                   "executor",
  "feature-notifier":                        "executor",
  "ceremony":                                "executor",
  "pr-remediator":                           "executor",
  "agent-fleet-health":                      "executor",
  "operator-routing":                        "executor",
  "google":                                  "executor",
  "a2a-delivery":                            "executor",
  "linear-protomaker-bridge":                "bridge",
  "debug":                                   "system",
  "logger":                                  "system",
  "bus-history-recorder":                    "system",
  "event-viewer":                            "system",
  "cli":                                     "system",
  "signal":                                  "system",
  "scheduler":                               "surface",
  "onboarding":                              "surface",
  "discord":                                 "surface",
  "github":                                  "surface",
  "linear":                                  "surface",
};

function pluginColumn(name: string): Column {
  return PLUGIN_COLUMN_OVERRIDES[name] ?? "misc";
}

function nodeColumn(n: Node): Column {
  // Surface pseudo-publisher synthesized by SystemGraph (O-4).
  if (n.id === "api-routes") return "surface";
  if (n.type === "agent")    return "agent";
  if (n.type === "service")  return "service";
  if (n.id.startsWith("plugin-")) return pluginColumn(n.id.slice("plugin-".length));
  return "misc";
}

/**
 * Per-column x offset. Wider gaps between columns where edges cross
 * heavily (executor → agent) keep the label space breathable.
 */
const COLUMN_X: Record<Column, number> = {
  system:       80,
  surface:     320,
  bridge:      560,
  router:      800,
  dispatcher: 1040,
  executor:   1340,
  agent:      1700,
  service:    2000,
  misc:       2280,
};

const ROW_HEIGHT_BY_TYPE: Record<string, number> = {
  agent:   120,
  service: 90,
};
const DEFAULT_ROW_HEIGHT = 64;

function rowHeightFor(n: Node): number {
  return ROW_HEIGHT_BY_TYPE[n.type ?? ""] ?? DEFAULT_ROW_HEIGHT;
}

/**
 * Lay out every node into its architectural column. Within a column,
 * nodes stack vertically in input order with the column centered around
 * y = 0. React Flow's `fitView` pans the result into view regardless
 * of where it lands.
 */
export function architecturalLayout(
  nodes: Node[],
  edges: Edge[],
): { nodes: Node[]; edges: Edge[] } {
  const buckets = new Map<Column, Node[]>();
  for (const col of COLUMNS) buckets.set(col, []);
  for (const n of nodes) buckets.get(nodeColumn(n))!.push(n);

  const laidOut: Node[] = [];
  for (const col of COLUMNS) {
    const stack = buckets.get(col)!;
    if (stack.length === 0) continue;

    const totalHeight = stack.reduce((acc, n) => acc + rowHeightFor(n), 0);
    let y = -totalHeight / 2;
    const x = COLUMN_X[col];

    for (const n of stack) {
      laidOut.push({ ...n, position: { x, y } });
      y += rowHeightFor(n);
    }
  }

  return { nodes: laidOut, edges };
}
