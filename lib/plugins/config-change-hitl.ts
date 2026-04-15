/**
 * ConfigChangeHITLPlugin — dedicated gate for workspace config changes.
 *
 * Distinct from the operational HITLPlugin so operators can tell apart
 * "this changes the rules of the system" (goals.yaml / actions.yaml edits)
 * from "this is a one-shot approval" (PR merge, cost escalation, etc.).
 *
 * Interface plugins register a renderer during install():
 *   configChangePlugin.registerRenderer("discord", renderer)
 *
 * Inbound topics:
 *   config.change.request.#  — new config-change approval needed
 *   config.change.response.# — human decision collected
 *
 * Pending requests are tracked in-memory with expiry. On a 60s interval,
 * expired entries are removed, config.change.expired.{correlationId} is
 * published, and the renderer's onExpired() is called.
 *
 * Payload shape for config.change.request.*: ConfigChangeRequest (lib/types.ts)
 * Payload shape for config.change.response.*: ConfigChangeResponse (lib/types.ts)
 */

import type {
  EventBus,
  BusMessage,
  Plugin,
  ConfigChangeRequest,
  ConfigChangeResponse,
  ConfigChangeRenderer,
} from "../types.ts";

// ── Renderer registry ──────────────────────────────────────────────────────
const renderers = new Map<string, ConfigChangeRenderer>();

// ── Pending request store ──────────────────────────────────────────────────
const pendingRequests = new Map<string, ConfigChangeRequest>();

// ── Plugin ────────────────────────────────────────────────────────────────

export class ConfigChangeHITLPlugin implements Plugin {
  readonly name = "config-change-hitl";
  readonly description =
    "Config-change gate — routes goals.yaml / actions.yaml approval requests to interface plugins";
  readonly capabilities = ["config-change-hitl-routing"];

  private expiryTimer: ReturnType<typeof setInterval> | null = null;

  /** All currently pending (unexpired, undecided) config-change requests. */
  getPendingRequests(): ConfigChangeRequest[] {
    return Array.from(pendingRequests.values());
  }

  /**
   * Register a ConfigChangeRenderer for an interface.
   * Call this from your plugin's install() before any requests arrive.
   */
  registerRenderer(interfaceName: string, renderer: ConfigChangeRenderer): void {
    renderers.set(interfaceName, renderer);
    console.log(`[config-change-hitl] Registered renderer for interface "${interfaceName}"`);
  }

  install(bus: EventBus): void {
    // ── Expiry sweep: every 60s, remove expired pending requests ────────
    this.expiryTimer = setInterval(() => {
      const now = Date.now();
      for (const [correlationId, req] of pendingRequests) {
        if (new Date(req.expiresAt).getTime() <= now) {
          pendingRequests.delete(correlationId);
          console.log(`[config-change-hitl] Expired ConfigChangeRequest (${correlationId})`);
          bus.publish(`config.change.expired.${correlationId}`, {
            id: crypto.randomUUID(),
            correlationId,
            topic: `config.change.expired.${correlationId}`,
            timestamp: Date.now(),
            payload: {
              type: "config_change_expired",
              correlationId,
              originalRequest: req,
            },
          });
          const iface = req.sourceMeta?.interface ?? "unknown";
          const renderer = renderers.get(iface);
          if (renderer?.onExpired) {
            renderer.onExpired(req, bus).catch((err) =>
              console.error(
                `[config-change-hitl] renderer.onExpired failed for ${correlationId}:`,
                err,
              ),
            );
          }
        }
      }
    }, 60_000);

    // ── Route ConfigChangeRequest to the correct interface ────────────
    bus.subscribe("config.change.request.#", this.name, (msg: BusMessage) => {
      const req = msg.payload as ConfigChangeRequest;
      if (req?.type !== "config_change_request") return;

      pendingRequests.set(req.correlationId, req);

      const iface = req.sourceMeta?.interface ?? "unknown";
      const renderer = renderers.get(iface);

      if (!renderer) {
        console.warn(
          `[config-change-hitl] No renderer for interface "${iface}" — ` +
            `config change request ${req.correlationId} will not be shown to operators`,
        );
        return;
      }

      console.log(
        `[config-change-hitl] Dispatching ConfigChangeRequest (${req.correlationId}) ` +
          `for "${req.configFile}" to "${iface}" renderer`,
      );
      renderer.render(req, bus).catch((err) =>
        console.error(
          `[config-change-hitl] renderer.render failed for ${req.correlationId}:`,
          err,
        ),
      );
    });

    // ── Clean up pending map when a response arrives ──────────────────
    bus.subscribe("config.change.response.#", this.name, (msg: BusMessage) => {
      const resp = msg.payload as ConfigChangeResponse;
      if (resp?.type !== "config_change_response") return;
      pendingRequests.delete(resp.correlationId);
    });
  }

  uninstall(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
}
