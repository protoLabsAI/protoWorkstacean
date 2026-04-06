/**
 * PlanePlugin — receives Plane webhook events and syncs issue state back.
 *
 * Inbound:
 *   POST /webhooks/plane → validates HMAC signature → deduplicates by delivery ID
 *   → message.inbound.plane.issue.{action}
 *
 * Outbound:
 *   plane.reply.# → PATCH issue state + add comment via Plane REST API
 *
 * Env vars:
 *   PLANE_WEBHOOK_SECRET   HMAC-SHA256 secret (skip verification if unset)
 *   PLANE_API_KEY           API key for outbound calls to Plane
 *   PLANE_BASE_URL          default: http://ava:3002
 *   PLANE_WORKSPACE_SLUG    default: protolabsai
 *   PLANE_WEBHOOK_PORT      webhook HTTP server port (default: 8083)
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { EventBus, BusMessage, Plugin } from "../types.ts";

// ── Plane webhook types ──────────────────────────────────────────────────────

interface PlaneIssue {
  id: string;
  name: string;
  description_html?: string;
  description_stripped?: string;
  priority: "urgent" | "high" | "medium" | "low" | "none";
  state: string;
  sequence_id: number;
  assignees: string[];
  labels: string[];
  parent: string | null;
  project: string;
  workspace: string;
}

interface PlaneProject {
  id: string;
  name: string;
  [key: string]: unknown;
}

interface PlaneCycle {
  id: string;
  name: string;
  [key: string]: unknown;
}

interface PlaneModule {
  id: string;
  name: string;
  [key: string]: unknown;
}

interface PlaneWebhookPayload {
  event: "issue" | "project" | "cycle" | "module" | "issue_comment";
  action: "create" | "update" | "delete";
  webhook_id: string;
  workspace_id: string;
  data: PlaneIssue | PlaneProject | PlaneCycle | PlaneModule;
  activity?: { actor: { id: string; display_name: string } };
}

// ── Signature verification ───────────────────────────────────────────────────

function verifyPlaneSignature(body: Buffer, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Deduplication ring buffer ────────────────────────────────────────────────

class DeliveryDedup {
  private seen = new Set<string>();
  private order: string[] = [];
  private maxSize: number;

  constructor(maxSize = 10_000) {
    this.maxSize = maxSize;
  }

  isDuplicate(id: string): boolean {
    if (this.seen.has(id)) return true;
    this.seen.add(id);
    this.order.push(id);
    while (this.order.length > this.maxSize) {
      const oldest = this.order.shift()!;
      this.seen.delete(oldest);
    }
    return false;
  }
}

// ── Label resolution cache ───────────────────────────────────────────────────

interface PlaneLabel {
  id: string;
  name: string;
}

interface PlaneState {
  id: string;
  name: string;
  group: string;
}

class PlaneAPICache {
  private baseUrl: string;
  private workspaceSlug: string;
  private apiKey: string;

  // projectId → label UUID → label name
  private labelCache = new Map<string, Map<string, string>>();
  // projectId → state group → state UUID
  private stateCache = new Map<string, Map<string, string>>();

  constructor(baseUrl: string, workspaceSlug: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.workspaceSlug = workspaceSlug;
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    return {
      "X-Api-Key": this.apiKey,
      "Content-Type": "application/json",
    };
  }

  async fetchLabels(projectId: string): Promise<Map<string, string>> {
    if (this.labelCache.has(projectId)) return this.labelCache.get(projectId)!;

    const map = new Map<string, string>();
    try {
      const url = `${this.baseUrl}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/labels/`;
      const resp = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      if (resp.ok) {
        const data = (await resp.json()) as { results?: PlaneLabel[] };
        for (const label of data.results ?? []) {
          map.set(label.id, label.name.toLowerCase());
        }
      } else {
        console.warn(`[plane] Failed to fetch labels for project ${projectId}: ${resp.status}`);
      }
    } catch (err) {
      console.error("[plane] Error fetching labels:", err);
    }

    this.labelCache.set(projectId, map);
    return map;
  }

  async fetchStates(projectId: string): Promise<Map<string, string>> {
    if (this.stateCache.has(projectId)) return this.stateCache.get(projectId)!;

    const map = new Map<string, string>();
    try {
      const url = `${this.baseUrl}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/states/`;
      const resp = await fetch(url, { headers: this.headers(), signal: AbortSignal.timeout(10_000) });
      if (resp.ok) {
        const data = (await resp.json()) as { results?: PlaneState[] };
        for (const state of data.results ?? []) {
          // Map group names like "started", "completed" to their state UUIDs
          map.set(state.group, state.id);
          // Also map by lowercased name for exact matches
          map.set(state.name.toLowerCase(), state.id);
        }
      } else {
        console.warn(`[plane] Failed to fetch states for project ${projectId}: ${resp.status}`);
      }
    } catch (err) {
      console.error("[plane] Error fetching states:", err);
    }

    this.stateCache.set(projectId, map);
    return map;
  }

  async hasLabel(projectId: string, labelUUIDs: string[], targetName: string): Promise<boolean> {
    const labels = await this.fetchLabels(projectId);
    return labelUUIDs.some(uuid => labels.get(uuid) === targetName.toLowerCase());
  }

  async patchIssueState(projectId: string, issueId: string, stateUUID: string): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${issueId}/`;
      const resp = await fetch(url, {
        method: "PATCH",
        headers: this.headers(),
        body: JSON.stringify({ state: stateUUID }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        console.error(`[plane] PATCH issue state failed: ${resp.status} ${await resp.text()}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error("[plane] Error patching issue state:", err);
      return false;
    }
  }

  async addIssueComment(projectId: string, issueId: string, comment: string): Promise<boolean> {
    try {
      const url = `${this.baseUrl}/api/v1/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${issueId}/activities/`;
      const resp = await fetch(url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ comment_html: `<p>${comment}</p>` }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) {
        console.error(`[plane] POST issue comment failed: ${resp.status} ${await resp.text()}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error("[plane] Error adding issue comment:", err);
      return false;
    }
  }

  /** Invalidate cached labels/states for a project so they're re-fetched next time. */
  invalidate(projectId: string): void {
    this.labelCache.delete(projectId);
    this.stateCache.delete(projectId);
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class PlanePlugin implements Plugin {
  readonly name = "plane";
  readonly description = "Plane webhook receiver — issue events → bus, outbound state sync";
  readonly capabilities = ["plane-inbound", "plane-outbound"];

  private server: ReturnType<typeof Bun.serve> | null = null;
  private workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  install(bus: EventBus): void {
    const webhookSecret = process.env.PLANE_WEBHOOK_SECRET ?? "";
    const apiKey = process.env.PLANE_API_KEY ?? "";
    const baseUrl = process.env.PLANE_BASE_URL ?? "http://ava:3002";
    const workspaceSlug = process.env.PLANE_WORKSPACE_SLUG ?? "protolabsai";
    const port = parseInt(process.env.PLANE_WEBHOOK_PORT ?? "8083", 10);

    if (!webhookSecret) {
      console.warn("[plane] PLANE_WEBHOOK_SECRET not set — signature verification disabled (dev mode)");
    }

    const dedup = new DeliveryDedup();
    let apiCache: PlaneAPICache | null = null;

    if (apiKey) {
      apiCache = new PlaneAPICache(baseUrl, workspaceSlug, apiKey);

      // ── Outbound: update Plane issues on reply ────────────────────────────
      bus.subscribe("plane.reply.#", "plane-outbound", async (msg: BusMessage) => {
        const payload = msg.payload as Record<string, unknown>;
        const planeIssueId = String(payload.planeIssueId ?? "");
        const planeProjectId = String(payload.planeProjectId ?? "");
        const status = String(payload.status ?? "");
        const summary = String(payload.summary ?? payload.content ?? "");

        if (!planeIssueId || !planeProjectId) {
          console.warn("[plane] outbound reply missing planeIssueId or planeProjectId");
          return;
        }

        // Resolve state UUIDs for this project
        const states = await apiCache!.fetchStates(planeProjectId);

        if (status === "created" || status === "in_progress") {
          const inProgressState = states.get("started") ?? states.get("in progress");
          if (inProgressState) {
            await apiCache!.patchIssueState(planeProjectId, planeIssueId, inProgressState);
            console.log(`[plane] Issue ${planeIssueId} → In Progress`);
          }
        } else if (status === "completed" || status === "done") {
          const doneState = states.get("completed") ?? states.get("done");
          if (doneState) {
            await apiCache!.patchIssueState(planeProjectId, planeIssueId, doneState);
            console.log(`[plane] Issue ${planeIssueId} → Done`);
          }
        }

        if (summary) {
          await apiCache!.addIssueComment(planeProjectId, planeIssueId, summary);
          console.log(`[plane] Comment added to issue ${planeIssueId}`);
        }
      });
    } else {
      console.warn("[plane] PLANE_API_KEY not set — outbound Plane API calls disabled");
    }

    // ── Inbound: webhook HTTP server ─────────────────────────────────────────
    this.server = Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname !== "/webhooks/plane") return new Response("Not found", { status: 404 });
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

        const bodyBuffer = Buffer.from(await req.arrayBuffer());

        // Signature verification
        if (webhookSecret) {
          const sig = req.headers.get("X-Plane-Signature") ?? "";
          if (!verifyPlaneSignature(bodyBuffer, sig, webhookSecret)) {
            console.warn("[plane] Invalid webhook signature — request rejected");
            return new Response("Unauthorized", { status: 401 });
          }
        }

        // Deduplication
        const deliveryId = req.headers.get("X-Plane-Delivery") ?? "";
        if (deliveryId && dedup.isDuplicate(deliveryId)) {
          return new Response("Already processed", { status: 200 });
        }

        let payload: PlaneWebhookPayload;
        try {
          payload = JSON.parse(bodyBuffer.toString("utf-8")) as PlaneWebhookPayload;
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        // Process asynchronously — return 200 immediately
        this._handleWebhook(payload, bus, apiCache).catch(err => {
          console.error("[plane] Webhook handler error:", err);
        });

        return new Response("OK", { status: 200 });
      },
    });

    console.log(`[plane] Webhook receiver on :${port}/webhooks/plane`);
  }

  uninstall(): void {
    this.server?.stop();
  }

  private async _handleWebhook(
    payload: PlaneWebhookPayload,
    bus: EventBus,
    apiCache: PlaneAPICache | null,
  ): Promise<void> {
    const { event, action, data } = payload;

    // Only process issue events for now
    if (event !== "issue") return;

    const issue = data as PlaneIssue;
    const topic = `message.inbound.plane.issue.${action}`;

    // Determine if this issue should trigger planning
    let shouldRoute = false;
    let autoApprove = false;

    if (action === "create") {
      // Check for plan/auto labels
      if (apiCache && issue.labels.length > 0) {
        const hasPlanLabel = await apiCache.hasLabel(issue.project, issue.labels, "plan");
        const hasAutoLabel = await apiCache.hasLabel(issue.project, issue.labels, "auto");

        if (hasPlanLabel || hasAutoLabel) {
          shouldRoute = true;
          autoApprove = hasAutoLabel;
        }
      }

      // Top-level issues (no parent) are potential epics — always route
      if (!issue.parent) {
        shouldRoute = true;
      }
    }

    if (!shouldRoute) {
      console.log(`[plane] ${event}.${action} on issue ${issue.id} — skipped (no matching trigger)`);
      return;
    }

    bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId: `plane-${issue.id}`,
      topic,
      timestamp: Date.now(),
      payload: {
        planeIssueId: issue.id,
        planeProjectId: issue.project,
        planeWorkspaceId: issue.workspace,
        planeSequenceId: issue.sequence_id,
        title: issue.name,
        description: issue.description_stripped ?? issue.name,
        content: `Plan: ${issue.name}\n\n${issue.description_stripped ?? issue.name}`,
        priority: issue.priority,
        labels: issue.labels,
        autoApprove,
        skillHint: "plan",
      },
      source: {
        interface: "plane" as const,
        channelId: issue.project,
        userId: payload.activity?.actor?.id,
      },
      reply: {
        topic: `plane.reply.${issue.id}`,
        format: "structured",
      },
    });

    console.log(
      `[plane] ${event}.${action} on issue "${issue.name}" (${issue.id}) → plan` +
      `${autoApprove ? " (auto-approve)" : ""}`,
    );
  }
}
