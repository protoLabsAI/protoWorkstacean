/**
 * HITLPlugin — Human-in-the-Loop gate for the Workstacean bus.
 *
 * Dispatches HITLRequest messages to registered HITLRenderer instances (one per
 * interface), and routes HITLResponse messages back to requesters via two paths:
 *   1. Bus callback — publishes to request.replyTopic (operational callers)
 *   2. A2A plan_resume — calls Ava to resume a checkpointed plan
 *
 * Interface plugins register a renderer during install():
 *   hitlPlugin.registerRenderer("discord", renderer)
 *
 * Inbound topics:
 *   hitl.request.#  — new approval needed
 *   hitl.response.# — human decision collected
 *
 * Pending requests are tracked in-memory with expiry. On a 60s interval,
 * expired entries are removed, hitl.expired.{correlationId} is published,
 * and the renderer's onExpired() is called.
 *
 * Config: workspace/agents.yaml (to find Ava's A2A endpoint for plan_resume)
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EventBus, BusMessage, Plugin, HITLRequest, HITLResponse, HITLRenderer } from "../types.ts";

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

// ── Renderer registry ─────────────────────────────────────────────────────────
// Maps interface name → HITLRenderer.
// Plugins call hitlPlugin.registerRenderer() during install() to hook in.

const renderers = new Map<string, HITLRenderer>();

// ── Pending request store ───────────────────────────────────────────────────

const pendingRequests = new Map<string, HITLRequest>();

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
  readonly description = "Human-in-the-Loop gate — routes approval requests to interface plugins and responses back to callers";
  readonly capabilities = ["hitl-routing"];

  private workspaceDir: string;
  private agents: AgentDef[] = [];
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private busRef: EventBus | null = null;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  /** All currently pending (unexpired, undecided) HITL requests. */
  getPendingRequests(): HITLRequest[] {
    return Array.from(pendingRequests.values());
  }

  /**
   * Register a HITLRenderer for an interface.
   * Call this from your plugin's install() before any HITLRequests arrive.
   */
  registerRenderer(interfaceName: string, renderer: HITLRenderer): void {
    renderers.set(interfaceName, renderer);
    console.log(`[hitl] Registered renderer for interface "${interfaceName}"`);
  }

  install(bus: EventBus): void {
    this.busRef = bus;
    this.agents = this._loadAgents();
    console.log(`[hitl] Loaded ${this.agents.length} agent(s) for plan_resume routing`);

    // ── Expiry sweep: every 60s, remove expired pending requests ─────────
    this.expiryTimer = setInterval(() => {
      const now = Date.now();
      for (const [correlationId, req] of pendingRequests) {
        if (new Date(req.expiresAt).getTime() <= now) {
          pendingRequests.delete(correlationId);
          console.log(`[hitl] Expired HITLRequest (${correlationId})`);
          bus.publish(`hitl.expired.${correlationId}`, {
            id: crypto.randomUUID(),
            correlationId,
            topic: `hitl.expired.${correlationId}`,
            timestamp: Date.now(),
            payload: { type: "hitl_expired", correlationId, originalRequest: req },
          });
          const iface = req.sourceMeta?.interface ?? "unknown";
          const renderer = renderers.get(iface);
          if (renderer?.onExpired) {
            renderer.onExpired(req, bus).catch(err =>
              console.error(`[hitl] renderer.onExpired failed for ${correlationId}:`, err),
            );
          }
        }
      }
    }, 60_000);

    // ── Route HITLRequest to the correct interface ───────────────────────
    bus.subscribe("hitl.request.#", this.name, (msg: BusMessage) => {
      const req = msg.payload as HITLRequest;
      if (req?.type !== "hitl_request") return;

      // Log cost escalation context if present
      if (req.escalation_reason) {
        console.log(
          `[hitl] Cost escalation (${req.correlationId}): ${req.escalation_reason}`,
        );
      }
      if (req.escalationContext) {
        const ctx = req.escalationContext;
        console.log(
          `[hitl] Cost context: tier=${ctx.tier}, est=$${ctx.estimatedCost.toFixed(4)}, max=$${ctx.maxCost.toFixed(4)}, ` +
          `remaining_project=$${ctx.budgetState.remainingProjectBudget.toFixed(4)}, ` +
          `remaining_daily=$${ctx.budgetState.remainingDailyBudget.toFixed(4)}`,
        );
      }

      // Store in pending map
      pendingRequests.set(req.correlationId, req);

      const iface = req.sourceMeta?.interface ?? "unknown";
      const renderer = renderers.get(iface);

      if (!renderer) {
        console.warn(`[hitl] No renderer for interface "${iface}" — publishing to hitl.pending`);
        bus.publish(`hitl.pending.${req.correlationId}`, {
          id: crypto.randomUUID(),
          correlationId: req.correlationId,
          topic: `hitl.pending.${req.correlationId}`,
          timestamp: Date.now(),
          payload: req,
        });
        return;
      }

      console.log(`[hitl] Dispatching HITLRequest (${req.correlationId}) to "${iface}" renderer`);
      renderer.render(req, bus).catch(err =>
        console.error(`[hitl] renderer.render failed for ${req.correlationId}:`, err),
      );
    });

    // ── Route HITLResponse back to Ava ───────────────────────────────────
    bus.subscribe("hitl.response.#", this.name, async (msg: BusMessage) => {
      const resp = msg.payload as HITLResponse;
      if (resp?.type !== "hitl_response") return;

      // Remove from pending map
      const pending = pendingRequests.get(resp.correlationId);
      if (pending) {
        pendingRequests.delete(resp.correlationId);
      } else {
        console.warn(`[hitl] No pending request for correlationId ${resp.correlationId} — processing anyway`);
      }

      // ── Bus delivery is automatic via pub/sub ────────────────────────────
      // The renderer published to request.replyTopic (a hitl.response.* topic).
      // Operational callers subscribed directly to that topic — they already
      // received the message. No re-publish needed from HITLPlugin.

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

  uninstall(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.busRef = null;
  }

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
