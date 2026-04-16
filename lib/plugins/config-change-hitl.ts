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

import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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

/**
 * Companion map keyed by correlationId → proposed new file content. Lets the
 * applier write the full approved content on decision=approve. Populated via
 * the propose endpoint (not via the bus topic, which carries only yamlDiff).
 */
const pendingContent = new Map<string, { targetPath: string; newContent: string }>();

/** Resolve the workspace-relative path a ConfigChangeRequest writes to. */
function resolveTargetPath(workspaceDir: string, req: ConfigChangeRequest): string | null {
  if (req.configFile === "goals.yaml" || req.configFile === "actions.yaml") {
    return join(workspaceDir, req.configFile);
  }
  if (typeof req.configFile === "object" && req.configFile.type === "agent") {
    if (!/^[\w\-]+$/.test(req.configFile.agentName)) return null;
    return join(workspaceDir, "agents", `${req.configFile.agentName}.yaml`);
  }
  return null;
}

/** Public helper so the propose HTTP endpoint can register the new content. */
export function recordPendingContent(correlationId: string, targetPath: string, newContent: string): void {
  pendingContent.set(correlationId, { targetPath, newContent });
}

// ── Plugin ────────────────────────────────────────────────────────────────

export class ConfigChangeHITLPlugin implements Plugin {
  readonly name = "config-change-hitl";
  readonly description =
    "Config-change gate — routes goals.yaml / actions.yaml approval requests to interface plugins";
  readonly capabilities = ["config-change-hitl-routing"];

  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private workspaceDir: string | null = null;

  /**
   * Optional workspace directory. When set, approved config-change responses
   * are applied automatically by writing the proposed newContent to the target
   * file. Without it, approvals are logged but nothing is written.
   */
  setWorkspaceDir(dir: string): void {
    this.workspaceDir = dir;
  }

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

    // ── Apply approved changes + clean up pending map on response ─────
    bus.subscribe("config.change.response.#", this.name, (msg: BusMessage) => {
      const resp = msg.payload as ConfigChangeResponse;
      if (resp?.type !== "config_change_response") return;

      const req = pendingRequests.get(resp.correlationId);
      const content = pendingContent.get(resp.correlationId);
      pendingRequests.delete(resp.correlationId);
      pendingContent.delete(resp.correlationId);

      if (resp.decision !== "approve") {
        console.log(
          `[config-change-hitl] ${resp.correlationId} rejected by ${resp.decidedBy}${resp.feedback ? ` — ${resp.feedback}` : ""}`,
        );
        return;
      }

      if (!req || !content || !this.workspaceDir) {
        console.warn(
          `[config-change-hitl] ${resp.correlationId} approved but missing request/content/workspaceDir — cannot auto-apply`,
        );
        return;
      }

      const targetPath = resolveTargetPath(this.workspaceDir, req);
      if (!targetPath || targetPath !== content.targetPath) {
        console.warn(
          `[config-change-hitl] ${resp.correlationId} approved but target path mismatch — refusing to apply`,
        );
        return;
      }

      try {
        if (!existsSync(targetPath)) {
          console.warn(`[config-change-hitl] target file ${targetPath} does not exist — refusing to create via approval`);
          return;
        }
        writeFileSync(targetPath, content.newContent, "utf8");
        console.log(
          `[config-change-hitl] ${resp.correlationId} applied by ${resp.decidedBy} → ${targetPath}`,
        );
        bus.publish(`config.change.applied.${resp.correlationId}`, {
          id: crypto.randomUUID(),
          correlationId: resp.correlationId,
          topic: `config.change.applied.${resp.correlationId}`,
          timestamp: Date.now(),
          payload: { type: "config_change_applied", correlationId: resp.correlationId, targetPath },
        });
      } catch (err) {
        console.error(`[config-change-hitl] apply failed for ${resp.correlationId}:`, err);
      }
    });
  }

  uninstall(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
  }
}
