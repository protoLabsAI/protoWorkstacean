/**
 * HITLPlugin — Human-in-the-Loop gate for the Workstacean bus.
 *
 * Routes HITLRequest messages to the correct interface plugin for rendering,
 * and HITLResponse messages back to the planning agent (Ava) for checkpoint
 * resumption.
 *
 * Inbound topics:
 *   hitl.request.#  — emitted by Ava after SPARC PRD + antagonistic review
 *   hitl.response.# — emitted by interface plugins after user decision
 *
 * Outbound routing (extensible via registerInterface):
 *   discord → message.outbound.discord.push.{channelId}
 *   api     → logged only (caller gets response inline via A2A)
 *   unknown → hitl.unrouted.{correlationId}
 *
 * Config: workspace/agents.yaml (to find Ava's A2A endpoint for plan_resume)
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EventBus, BusMessage, Plugin, HITLRequest, HITLResponse } from "../types.ts";

// ── Agent registry (minimal — just enough to find Ava) ──────────────────────

interface AgentDef {
  name: string;
  url: string;
  apiKeyEnv?: string;
  skills: string[];
}

interface AgentsYaml {
  agents: AgentDef[];
}

// ── Interface router ─────────────────────────────────────────────────────────
// Maps interface name → function that returns the outbound topic for a given HITLRequest.
// Plugins can call registerInterface() to extend this.

type InterfaceRouter = (req: HITLRequest) => string | null;

const interfaceRouters = new Map<string, InterfaceRouter>();

// Built-in routers
interfaceRouters.set("discord", (req: HITLRequest) => {
  const channelId = req.sourceMeta?.channelId;
  if (!channelId) return null;
  return `message.outbound.discord.push.${channelId}`;
});

interfaceRouters.set("api", (_req: HITLRequest) => {
  // API callers get the response inline via A2A — no bus routing needed
  return null;
});

/** Register a custom interface router. Plugins call this to extend HITL routing. */
export function registerInterface(name: string, router: InterfaceRouter): void {
  interfaceRouters.set(name, router);
}

// ── A2A call to Ava for plan_resume ──────────────────────────────────────────

async function callPlanResume(agent: AgentDef, response: HITLResponse): Promise<void> {
  const apiKey = agent.apiKeyEnv ? (process.env[agent.apiKeyEnv] ?? "") : "";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;

  const content = [
    `HITL Decision: ${response.decision}`,
    response.feedback ? `Feedback: ${response.feedback}` : "",
    `Decided by: ${response.decidedBy}`,
  ].filter(Boolean).join("\n");

  const resp = await fetch(agent.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: {
        message: { role: "user", parts: [{ kind: "text", text: content }] },
        contextId: response.correlationId,
        metadata: { skillHint: "plan_resume", hitlResponse: response },
      },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`plan_resume A2A call failed (${resp.status}): ${errText}`);
  }

  const data = (await resp.json()) as { error?: { message: string } };
  if (data.error) throw new Error(data.error.message);
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export class HITLPlugin implements Plugin {
  readonly name = "hitl";
  readonly description = "Human-in-the-Loop gate — routes approval requests to interface plugins and responses back to Ava";
  readonly capabilities = ["hitl-routing"];

  private workspaceDir: string;
  private agents: AgentDef[] = [];

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  install(bus: EventBus): void {
    this.agents = this._loadAgents();
    console.log(`[hitl] Loaded ${this.agents.length} agent(s) for plan_resume routing`);

    // ── Route HITLRequest to the correct interface ───────────────────────
    bus.subscribe("hitl.request.#", this.name, (msg: BusMessage) => {
      const req = msg.payload as HITLRequest;
      if (req?.type !== "hitl_request") return;

      const iface = req.sourceMeta?.interface ?? "unknown";
      const router = interfaceRouters.get(iface);

      if (!router) {
        console.warn(`[hitl] No router for interface "${iface}" — publishing to hitl.unrouted`);
        bus.publish(`hitl.unrouted.${req.correlationId}`, {
          id: crypto.randomUUID(),
          correlationId: req.correlationId,
          topic: `hitl.unrouted.${req.correlationId}`,
          timestamp: Date.now(),
          payload: req,
        });
        return;
      }

      const outboundTopic = router(req);
      if (!outboundTopic) {
        console.log(`[hitl] Interface "${iface}" returned no outbound topic (inline response) — skipping bus publish`);
        return;
      }

      console.log(`[hitl] Routing HITLRequest (${req.correlationId}) → ${outboundTopic}`);
      bus.publish(outboundTopic, {
        id: crypto.randomUUID(),
        correlationId: req.correlationId,
        topic: outboundTopic,
        timestamp: Date.now(),
        payload: req,
      });
    });

    // ── Route HITLResponse back to Ava ───────────────────────────────────
    bus.subscribe("hitl.response.#", this.name, async (msg: BusMessage) => {
      const resp = msg.payload as HITLResponse;
      if (resp?.type !== "hitl_response") return;

      // Find agent with plan_resume skill (should be Ava)
      const planAgent = this.agents.find(a => a.skills.includes("plan_resume"));
      if (!planAgent) {
        console.error("[hitl] No agent with plan_resume skill found — cannot route HITLResponse");
        return;
      }

      console.log(`[hitl] Routing HITLResponse (${resp.correlationId}, decision: ${resp.decision}) → ${planAgent.name}`);

      try {
        await callPlanResume(planAgent, resp);
        console.log(`[hitl] plan_resume call to ${planAgent.name} succeeded`);
      } catch (err) {
        console.error(`[hitl] plan_resume call to ${planAgent.name} failed:`, err);
      }
    });
  }

  uninstall(): void {}

  private _loadAgents(): AgentDef[] {
    const agentsPath = join(this.workspaceDir, "agents.yaml");
    if (!existsSync(agentsPath)) {
      console.warn("[hitl] agents.yaml not found — HITL response routing will be unavailable");
      return [];
    }

    try {
      const raw = readFileSync(agentsPath, "utf8");
      const parsed = parseYaml(raw) as AgentsYaml;
      return parsed.agents ?? [];
    } catch (err) {
      console.error("[hitl] Failed to parse agents.yaml:", err);
      return [];
    }
  }
}
