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
 * Transport: JSON-RPC, mounted at POST /a2a by a2a-server.ts. The card's
 * `url` is the canonical A2A endpoint that spec-compliant clients hit after
 * card discovery. Resolution order:
 *
 *   1. WORKSTACEAN_PUBLIC_BASE_URL  — operator-set canonical public base
 *      (e.g. https://ava.proto-labs.ai). Use this for cross-host / external
 *      callers that need a stable, Cloudflare-fronted URL.
 *   2. http://${WORKSTACEAN_INTERNAL_HOST ?? "workstacean"}:${HTTP_PORT}/a2a
 *      — the docker-network service name + the actual API port. This is what
 *      sibling services in the compose network reach by default.
 *
 * `additionalInterfaces` mirrors the same URL under the explicit `jsonrpc`
 * transport so clients that walk the interfaces list can pick deterministically.
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

function resolveA2aUrl(): string {
  const publicBase = (process.env.WORKSTACEAN_PUBLIC_BASE_URL ?? "").replace(/\/$/, "");
  if (publicBase) return `${publicBase}/a2a`;
  const host = process.env.WORKSTACEAN_INTERNAL_HOST ?? "workstacean";
  const port = process.env.WORKSTACEAN_HTTP_PORT ?? "3000";
  return `http://${host}:${port}/a2a`;
}

export function buildAgentCard(ctx: ApiContext): AgentCard {
  const a2aUrl = resolveA2aUrl();

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
    url: a2aUrl,
    preferredTransport: "JSONRPC",
    additionalInterfaces: [{ transport: "JSONRPC", url: a2aUrl }],
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
