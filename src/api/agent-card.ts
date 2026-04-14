/**
 * Agent Card endpoint — serves GET /.well-known/agent-card.json (with a
 * legacy /.well-known/agent.json alias).
 *
 * Exposes workstacean as an A2A-compliant agent gateway. The card aggregates
 * every skill currently registered in the ExecutorRegistry so external agents
 * can discover what workstacean can route to. Re-reads the registry on each
 * request so newly discovered A2A skills (Phase 4 periodic refresh) show up
 * without a restart.
 *
 * Skills list the id + name only. Tags default to ["routed"] — the caller
 * doesn't need to know what machinery is behind a skill, just that they can
 * dispatch it by name.
 *
 * Transport: JSON-RPC (mounted at POST /a2a by a2a-server.ts). Agents send
 * messages to that URL; the AgentCard.url field is derived from
 * WORKSTACEAN_BASE_URL so external agents get an absolute URL.
 */

import type { Route, ApiContext } from "./types.ts";
import type { AgentCard, AgentSkill } from "@a2a-js/sdk";

const DEFAULT_VERSION = "1.0.0";
const PROTOCOL_VERSION = "0.3.0";

export function createRoutes(ctx: ApiContext): Route[] {
  const handler = () => {
    const card = buildAgentCard(ctx);
    return Response.json(card, {
      headers: { "cache-control": "public, max-age=60" },
    });
  };

  return [
    { method: "GET", path: "/.well-known/agent-card.json", handler },
    // Legacy path — keep for agents that still resolve /.well-known/agent.json
    { method: "GET", path: "/.well-known/agent.json", handler },
  ];
}

export function buildAgentCard(ctx: ApiContext): AgentCard {
  const baseUrl = (process.env.WORKSTACEAN_BASE_URL ?? "").replace(/\/$/, "")
    || `http://localhost:${process.env.WORKSTACEAN_HTTP_PORT ?? "3000"}`;

  const registrations = ctx.executorRegistry.list();
  // Dedupe by skill — multiple agents may register the same skill; external
  // callers only need to see the skill once, and workstacean handles target
  // selection via ExecutorRegistry.resolve().
  const seen = new Set<string>();
  const skills: AgentSkill[] = [];
  for (const reg of registrations) {
    if (!reg.skill || seen.has(reg.skill)) continue;
    seen.add(reg.skill);
    skills.push({
      id: reg.skill,
      name: reg.skill,
      description: `Skill routed by workstacean to ${reg.agentName ?? "default executor"}`,
      tags: ["routed", reg.agentName ?? "default"].filter(Boolean),
    });
  }

  return {
    name: "workstacean",
    description:
      "protoLabs Studio operational gateway. Routes skill requests across the " +
      "agent fleet (Ava, Quinn, Frank, Jon, Cindi, Researcher, protopen, etc).",
    protocolVersion: PROTOCOL_VERSION,
    version: DEFAULT_VERSION,
    url: `${baseUrl}/a2a`,
    preferredTransport: "JSONRPC",
    provider: {
      organization: "protoLabs AI",
      url: "https://protolabs.ai",
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    capabilities: {
      streaming: true,
      pushNotifications: true,
      stateTransitionHistory: false,
    },
    skills,
  };
}
