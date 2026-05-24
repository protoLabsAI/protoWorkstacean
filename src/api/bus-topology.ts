/**
 * GET /api/bus/topology — plugin → topics graph.
 *
 * Reads `plugin.publishes` and `plugin.subscribes` from each installed
 * plugin and aggregates them into a topology document. Plugins that don't
 * yet declare these fields show up with empty arrays.
 *
 * Shape:
 *   {
 *     plugins: [{ name, publishes: [...], subscribes: [...] }],
 *     topics: { [topic]: { publishedBy: [pluginName], subscribedBy: [pluginName] } }
 *   }
 *
 * The `topics` index makes it trivial to spot orphans: a topic with
 * `publishedBy` but no `subscribedBy` (dead emit), or vice versa
 * (subscriber waiting for a producer that doesn't exist).
 */

import type { Route, ApiContext } from "./types.ts";
import type { Plugin } from "../../lib/types.ts";

interface PluginNode {
  name: string;
  description?: string;
  capabilities?: string[];
  publishes: string[];
  subscribes: string[];
}

interface TopicEntry {
  publishedBy: string[];
  subscribedBy: string[];
}

export interface BusTopology {
  plugins: PluginNode[];
  topics: Record<string, TopicEntry>;
}

export function buildTopology(plugins: Plugin[]): BusTopology {
  const pluginNodes: PluginNode[] = plugins.map(p => ({
    name: p.name,
    description: p.description,
    capabilities: p.capabilities,
    publishes: p.publishes ?? [],
    subscribes: p.subscribes ?? [],
  }));

  const topics: Record<string, TopicEntry> = {};
  for (const plugin of pluginNodes) {
    for (const topic of plugin.publishes) {
      const entry = topics[topic] ?? (topics[topic] = { publishedBy: [], subscribedBy: [] });
      entry.publishedBy.push(plugin.name);
    }
    for (const topic of plugin.subscribes) {
      const entry = topics[topic] ?? (topics[topic] = { publishedBy: [], subscribedBy: [] });
      entry.subscribedBy.push(plugin.name);
    }
  }

  return { plugins: pluginNodes, topics };
}

export function createRoutes(ctx: ApiContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/bus/topology",
      handler: () => Response.json({ success: true, data: buildTopology(ctx.plugins) }),
    },
  ];
}
