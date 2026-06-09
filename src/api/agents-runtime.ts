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
 *         { name: "roxy", type: "a2a", skills: [...], host: "roxy:7870" },
 *         { name: "function", type: "function", skills: ["alert.*", ...] },
 *         ...
 *       ]
 *     }
 *   }
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Route, ApiContext } from "./types.ts";

export interface AgentSummary {
  name: string;
  type: string;
  skills: string[];
  /** True iff this agent is known from yaml but hasn't registered any skill yet (A2A card discovery in flight). */
  pendingDiscovery?: boolean;
  /** For A2A agents: the endpoint host[:port] (e.g. "roxy:7870"), derived from the yaml url. The canvas tags remote nodes with where they live. */
  host?: string;
}

interface YamlAgent {
  name?: string;
  url?: string;
  external?: boolean;
}

/**
 * Endpoint host[:port] from an A2A url, or undefined if absent/unparseable.
 * `http://roxy:7870/a2a` → `roxy:7870`. The default-port case keeps the bare
 * host. Pure — unit-tested directly; the canvas shows this on A2A nodes.
 */
export function hostFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A2A agents declared on disk (name + endpoint host): the hand-maintained
 * agents.yaml plus each control-plane-managed agents.d/*.yaml (ADR-0004 P3).
 * These may not be in the registry yet (card discovery in flight) but should
 * render eagerly, and their host is known statically from the yaml url.
 */
function loadDeclaredA2aAgents(workspaceDir: string): Array<{ name: string; host?: string }> {
  const agents: Array<{ name: string; host?: string }> = [];

  const yamlPath = join(workspaceDir, "agents.yaml");
  if (existsSync(yamlPath)) {
    try {
      const parsed = parseYaml(readFileSync(yamlPath, "utf8")) as { agents?: YamlAgent[] };
      for (const a of Array.isArray(parsed?.agents) ? parsed.agents : []) {
        if (a?.name) agents.push({ name: a.name, host: hostFromUrl(a.url) });
      }
    } catch {
      // Tolerate parse errors — the live registry view is still useful and an
      // over-noisy 500 on /api/agents/runtime breaks the dashboard.
    }
  }

  const dir = join(workspaceDir, "agents.d");
  if (existsSync(dir)) {
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
      try {
        const parsed = parseYaml(readFileSync(join(dir, file), "utf8")) as YamlAgent;
        if (parsed?.name) agents.push({ name: parsed.name, host: hostFromUrl(parsed.url) });
      } catch {
        // skip an unparseable managed file
      }
    }
  }

  return agents;
}

/**
 * The live fleet: every registered executor grouped by (agentName ?? type),
 * merged with declared-but-not-yet-discovered A2A agents (pendingDiscovery).
 * Shared by GET /api/agents/runtime and the unified control-plane read.
 */
export function collectFleetAgents(ctx: ApiContext): AgentSummary[] {
  const byKey = new Map<string, { type: string; skills: Set<string> }>();
  for (const reg of ctx.executorRegistry.list()) {
    const key = reg.agentName ?? reg.executor.type;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { type: reg.executor.type, skills: new Set() };
      byKey.set(key, entry);
    }
    if (reg.skill) entry.skills.add(reg.skill);
  }

  // Merge declared A2A agents. If already in the registry (discovered /
  // in-process), the registry wins; otherwise mark pendingDiscovery so the
  // dashboard renders a node with no skills yet. Either way the yaml is the
  // source of truth for the endpoint host.
  const declared = loadDeclaredA2aAgents(ctx.workspaceDir);
  const hostByName = new Map(declared.map((d) => [d.name, d.host]));
  for (const { name } of declared) {
    if (byKey.has(name)) continue;
    byKey.set(name, { type: "a2a", skills: new Set() });
  }

  return [...byKey.entries()]
    .map(([name, { type, skills }]) => {
      const skillList = [...skills].sort();
      const summary: AgentSummary = { name, type, skills: skillList };
      if (type === "a2a") {
        const host = hostByName.get(name);
        if (host) summary.host = host;
        if (skillList.length === 0) summary.pendingDiscovery = true;
      }
      return summary;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function createRoutes(ctx: ApiContext): Route[] {
  return [
    {
      method: "GET",
      path: "/api/agents/runtime",
      handler: () => Response.json({ success: true, data: { agents: collectFleetAgents(ctx) } }),
    },
  ];
}
