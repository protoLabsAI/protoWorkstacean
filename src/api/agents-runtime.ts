/**
 * GET /api/agents/runtime — list every registered executor, grouped by agent.
 *
 * Combines two sources so the /system dashboard sees the complete fleet:
 *
 *   1. ExecutorRegistry — every live registration grouped by
 *      (agentName ?? executor.type). Catches in-process DeepAgents
 *      (quinn / ava / protobot) plus the function-executor cluster for
 *      alert.* / ceremony.* / pr.* skills.
 *
 *   2. workspace/agents.yaml — A2A agents (protomaker, protopen). These
 *      don't appear in the registry until SkillBrokerPlugin's async card
 *      discovery completes, but they're known statically from yaml. We
 *      surface them eagerly with a `pendingDiscovery: true` marker
 *      so the dashboard renders the node even before discovery returns.
 *      Once discovery lands, the executor registration takes over and
 *      the pending flag clears.
 *
 * Response shape:
 *   {
 *     success: true,
 *     data: {
 *       agents: [
 *         { name: "quinn", type: "deep-agent", skills: ["pr_review", ...] },
 *         { name: "protomaker", type: "a2a", skills: [...], pendingDiscovery: false },
 *         { name: "function", type: "function", skills: ["alert.*", ...] },
 *         ...
 *       ]
 *     }
 *   }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Route, ApiContext } from "./types.ts";

interface AgentSummary {
  name: string;
  type: string;
  skills: string[];
  /** True iff this agent is known from yaml but hasn't registered any skill yet (A2A card discovery in flight). */
  pendingDiscovery?: boolean;
}

interface YamlAgent {
  name?: string;
  url?: string;
  external?: boolean;
}

function loadYamlAgents(workspaceDir: string): YamlAgent[] {
  const path = join(workspaceDir, "agents.yaml");
  if (!existsSync(path)) return [];
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as { agents?: YamlAgent[] };
    return Array.isArray(parsed?.agents) ? parsed.agents : [];
  } catch {
    // Tolerate yaml parse errors — the live registry view is still useful
    // and an over-noisy 500 on /api/agents/runtime breaks the dashboard.
    return [];
  }
}

export function createRoutes(ctx: ApiContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/agents/runtime",
      handler: () => {
        const registrations = ctx.executorRegistry.list();

        // 1. Group registry entries by (agentName ?? executor.type).
        const byKey = new Map<string, { type: string; skills: Set<string> }>();
        for (const reg of registrations) {
          const key = reg.agentName ?? reg.executor.type;
          let entry = byKey.get(key);
          if (!entry) {
            entry = { type: reg.executor.type, skills: new Set() };
            byKey.set(key, entry);
          }
          if (reg.skill) entry.skills.add(reg.skill);
        }

        // 2. Merge in yaml-declared A2A agents. If they already have a
        // registry entry (skills discovered, in-process loaded), the
        // registry data wins. Otherwise we mark them pendingDiscovery
        // so the dashboard renders a node with no skills yet.
        for (const ya of loadYamlAgents(ctx.workspaceDir)) {
          if (!ya.name) continue;
          if (byKey.has(ya.name)) continue;
          byKey.set(ya.name, { type: "a2a", skills: new Set() });
        }

        const agents: AgentSummary[] = [...byKey.entries()]
          .map(([name, { type, skills }]) => {
            const skillList = [...skills].sort();
            const summary: AgentSummary = { name, type, skills: skillList };
            // Only A2A agents can be in "discovery pending" — others
            // either declare their skills via yaml (deep-agents) or are
            // synthetic plugin-level (function).
            if (type === "a2a" && skillList.length === 0) {
              summary.pendingDiscovery = true;
            }
            return summary;
          })
          .sort((a, b) => a.name.localeCompare(b.name));

        return Response.json({ success: true, data: { agents } });
      },
    },
  ];
}
