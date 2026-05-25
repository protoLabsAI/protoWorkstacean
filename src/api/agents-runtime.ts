/**
 * GET /api/agents/runtime — list every registered executor, grouped by agent.
 *
 * The existing GET /api/agents only returns the A2A registry from
 * workspace/agents.yaml. The /system dashboard also needs in-process
 * agents (DeepAgents like Quinn / Ava / protobot) and function-skill
 * executors (alert.* / ceremony.* / pr.*) for the topology graph.
 *
 * Pulls live data from ExecutorRegistry so the response reflects what's
 * actually wired in this process — not what a yaml says should be wired.
 *
 * Response:
 *   {
 *     success: true,
 *     data: {
 *       agents: [
 *         { name: "quinn", type: "deep-agent", skills: ["pr_review","bug_triage", ...] },
 *         { name: "protomaker", type: "a2a", skills: [...] },
 *         { name: "alert-skill-executor", type: "function", skills: ["alert.ci_main_red", ...] },
 *         ...
 *       ]
 *     }
 *   }
 */

import type { Route, ApiContext } from "./types.ts";

interface AgentSummary {
  name: string;
  type: string;
  skills: string[];
}

export function createRoutes(ctx: ApiContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/agents/runtime",
      handler: () => {
        const registrations = ctx.executorRegistry.list();

        // Group by (agentName ?? executor.type). Each unique grouping becomes
        // one node on the dashboard. agentName takes precedence so quinn / ava
        // / protobot show up as individuals; nameless function executors
        // collapse under their executor type ("function").
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

        const agents: AgentSummary[] = [...byKey.entries()]
          .map(([name, { type, skills }]) => ({
            name,
            type,
            skills: [...skills].sort(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        return Response.json({ success: true, data: { agents } });
      },
    },
  ];
}
