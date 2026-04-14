/**
 * HITLPlugin — Human-in-the-Loop gate for the Workstacean bus.
 *
 * Pure routing layer between HITL requests and registered renderers.
 * TaskTracker owns the A2A native `input-required` resume path — when a
 * response arrives for a tracked A2A task, the tracker re-sends via
 * sendMessage(taskId, decisionText). This plugin just orchestrates the
 * request/renderer/response bus plumbing.
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
 */

import type { EventBus, BusMessage, Plugin, HITLRequest, HITLResponse, HITLRenderer } from "../types.ts";

// ── Renderer registry ─────────────────────────────────────────────────────────
// Maps interface name → HITLRenderer.
// Plugins call hitlPlugin.registerRenderer() during install() to hook in.

const renderers = new Map<string, HITLRenderer>();

// ── Pending request store ───────────────────────────────────────────────────

const pendingRequests = new Map<string, HITLRequest>();

/**
 * CorrelationIds of requests that arrived without a matching renderer —
 * they were published to hitl.pending but no channel can render them. A
 * routing hole. Exposed via the hitl_queue domain so a goal can alert on
 * it (see workspace/goals.yaml#hitl.no_unrendered_requests).
 */
const unrenderedCorrelationIds = new Set<string>();

// ── Plugin ───────────────────────────────────────────────────────────────────

export class HITLPlugin implements Plugin {
  readonly name = "hitl";
  readonly description = "Human-in-the-Loop gate — routes approval requests to interface plugins";
  readonly capabilities = ["hitl-routing"];

  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private busRef: EventBus | null = null;

  constructor(_workspaceDir: string) {
    // workspaceDir retained for API compat with existing plugin constructors,
    // but not used — HITL is pure bus routing now.
  }

  /** All currently pending (unexpired, undecided) HITL requests. */
  getPendingRequests(): HITLRequest[] {
    return Array.from(pendingRequests.values());
  }

  /**
   * Queue snapshot for the world-state `hitl_queue` domain.
   * - pendingCount: all pending (rendered + unrendered)
   * - unrenderedCount: pending that had no matching renderer (routing hole)
   */
  getQueueSnapshot(): { pendingCount: number; unrenderedCount: number } {
    return {
      pendingCount: pendingRequests.size,
      unrenderedCount: unrenderedCorrelationIds.size,
    };
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

    // ── Expiry sweep: every 60s, remove expired pending requests ─────────
    this.expiryTimer = setInterval(() => {
      const now = Date.now();
      for (const [correlationId, req] of pendingRequests) {
        if (new Date(req.expiresAt).getTime() <= now) {
          pendingRequests.delete(correlationId);
          unrenderedCorrelationIds.delete(correlationId);

          if (req.onTimeout === "approve" || req.onTimeout === "reject") {
            // Auto-respond according to the TTL policy
            console.log(`[hitl] TTL expired → auto-${req.onTimeout} (${correlationId})`);
            const autoResp: HITLResponse = {
              type: "hitl_response",
              correlationId,
              decision: req.onTimeout,
              decidedBy: `auto-${req.onTimeout}`,
            };
            bus.publish(`hitl.response.${correlationId}`, {
              id: crypto.randomUUID(),
              correlationId,
              topic: `hitl.response.${correlationId}`,
              timestamp: Date.now(),
              payload: autoResp,
            });
          } else {
            // onTimeout === "escalate" or not set — emit expired event for escalation handlers
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
        unrenderedCorrelationIds.add(req.correlationId);
        console.warn(`[hitl] No renderer for interface "${iface}" — publishing to hitl.pending (correlationId=${req.correlationId}, unrendered=${unrenderedCorrelationIds.size})`);
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

    // ── Clean up pending map when a response arrives ─────────────────────
    // Bus delivery of the response is automatic — renderers published to
    // request.replyTopic (a hitl.response.* topic) and callers subscribed
    // directly. TaskTracker subscribes to hitl.response.# for A2A tasks
    // and resumes via sendMessage(taskId, decisionText).
    bus.subscribe("hitl.response.#", this.name, (msg: BusMessage) => {
      const resp = msg.payload as HITLResponse;
      if (resp?.type !== "hitl_response") return;
      pendingRequests.delete(resp.correlationId);
      unrenderedCorrelationIds.delete(resp.correlationId);
    });
  }

  uninstall(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.busRef = null;
  }
}
