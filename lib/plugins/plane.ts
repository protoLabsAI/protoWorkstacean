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
import { PlaneClient } from "../plane-client.ts";

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
  action: "created" | "updated" | "deleted";
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

// ── Plugin ────────────────────────────────────────────────────────────────────

export class PlanePlugin implements Plugin {
  readonly name = "plane";
  readonly description = "Plane webhook receiver — issue events → bus, outbound state sync";
  readonly capabilities = ["plane-inbound", "plane-outbound"];

  private server: ReturnType<typeof Bun.serve> | null = null;
  private workspaceDir: string;
  // Maps correlationId → {planeIssueId, planeProjectId} so outbound handler can
  // resolve Plane context even when the A2A reply payload doesn't carry it.
  private pendingIssues = new Map<string, { planeIssueId: string; planeProjectId: string }>();

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
    let apiCache: PlaneClient | null = null;

    if (apiKey) {
      apiCache = new PlaneClient(baseUrl, workspaceSlug, apiKey);

      // ── Outbound: update Plane issues on reply ────────────────────────────
      bus.subscribe("plane.reply.#", "plane-outbound", async (msg: BusMessage) => {
        const payload = msg.payload as Record<string, unknown>;
        const status = String(payload.status ?? "");
        const summary = String(payload.summary ?? payload.content ?? "");

        // Resolve Plane context: prefer explicit payload fields, fall back to
        // the pending map keyed by correlationId (set when the inbound was published).
        const pending = msg.correlationId ? this.pendingIssues.get(msg.correlationId) : undefined;
        const planeIssueId = String(payload.planeIssueId ?? pending?.planeIssueId ?? "");
        const planeProjectId = String(payload.planeProjectId ?? pending?.planeProjectId ?? "");

        if (!planeIssueId || !planeProjectId) {
          console.warn("[plane] outbound reply missing planeIssueId or planeProjectId — skipping Plane sync");
          return;
        }

        // Clean up pending entry on final status
        if (status === "completed" || status === "done" || status === "rejected") {
          this.pendingIssues.delete(msg.correlationId ?? "");
        }

        // Resolve state UUIDs for this project
        const states = await apiCache!.fetchStates(planeProjectId);

        if (status === "created" || status === "in_progress") {
          const inProgressState = states.get("group:started") ?? states.get("name:in progress");
          if (inProgressState) {
            await apiCache!.patchIssueState(planeProjectId, planeIssueId, inProgressState);
            console.log(`[plane] Issue ${planeIssueId} → In Progress`);
          }
          bus.publish("flow.item.updated", {
            id: crypto.randomUUID(),
            correlationId: msg.correlationId ?? "",
            topic: "flow.item.updated",
            timestamp: Date.now(),
            payload: { id: `plane-${planeIssueId}`, status: "active", stage: "in-progress" },
          });
        } else if (status === "completed" || status === "done") {
          const doneState = states.get("group:completed") ?? states.get("name:done");
          if (doneState) {
            await apiCache!.patchIssueState(planeProjectId, planeIssueId, doneState);
            console.log(`[plane] Issue ${planeIssueId} → Done`);
          }
          bus.publish("flow.item.completed", {
            id: crypto.randomUUID(),
            correlationId: msg.correlationId ?? "",
            topic: "flow.item.completed",
            timestamp: Date.now(),
            payload: { id: `plane-${planeIssueId}`, status: "complete", stage: "done", completedAt: Date.now() },
          });
        }

        if (summary) {
          const commented = await apiCache!.addIssueComment(planeProjectId, planeIssueId, summary);
          if (commented) console.log(`[plane] Comment added to issue ${planeIssueId}`);
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
    apiCache: PlaneClient | null,
  ): Promise<void> {
    const { event, action, data } = payload;

    // Only process issue events for now
    if (event !== "issue") return;

    const issue = data as PlaneIssue;
    const topic = `message.inbound.plane.issue.${action}`;

    // Determine if this issue should trigger planning and which skill it
    // routes to. Label → skill mapping (evaluated in order):
    //
    //   security → security_triage  — always high priority
    //   bug      → bug_triage        — file a fix feature on the board
    //   research → plan              — research spike, treated as planning
    //   plan     → plan              — explicit planning request
    //   auto     → plan (autoApprove) — planning + auto-execute
    //
    // Top-level issues (no parent) with NO matching label fall through to
    // "plan" as the epic path. Leaf issues with no matching label are
    // skipped — they're just notes, not actionable work.
    let shouldRoute = false;
    let skillHint = "plan";
    let autoApprove = false;

    if (action === "created") {
      if (apiCache && issue.labels.length > 0) {
        // Resolve all labels once and match in priority order
        const hasLabel = async (name: string) =>
          apiCache!.hasLabel(issue.project, issue.labels, name);

        if (await hasLabel("security")) {
          shouldRoute = true;
          skillHint = "security_triage";
        } else if (await hasLabel("bug")) {
          shouldRoute = true;
          skillHint = "bug_triage";
        } else if (await hasLabel("research")) {
          shouldRoute = true;
          skillHint = "plan";
        } else if (await hasLabel("plan")) {
          shouldRoute = true;
          skillHint = "plan";
        } else if (await hasLabel("auto")) {
          shouldRoute = true;
          skillHint = "plan";
          autoApprove = true;
        }
      }

      // Top-level issues (no parent) are potential epics — fall through to
      // plan if no explicit skill label matched.
      if (!shouldRoute && !issue.parent) {
        shouldRoute = true;
        skillHint = "plan";
      }
    }

    if (!shouldRoute) {
      console.log(`[plane] ${event}.${action} on issue ${issue.id} — skipped (no matching trigger)`);
      return;
    }

    const correlationId = `plane-${issue.id}`;
    this.pendingIssues.set(correlationId, { planeIssueId: issue.id, planeProjectId: issue.project });

    // Register this issue as a flow item so FlowMonitorPlugin can track its
    // lifecycle. Derive the flow type from the resolved skill so distribution
    // metrics reflect reality (security_triage → risk, bug_triage → defect,
    // anything else → feature). Urgent priority overrides feature → defect.
    let flowItemType: "feature" | "defect" | "risk" | "debt" = "feature";
    if (skillHint === "security_triage") flowItemType = "risk";
    else if (skillHint === "bug_triage") flowItemType = "defect";
    else if (issue.priority === "urgent") flowItemType = "defect";
    bus.publish("flow.item.created", {
      id: crypto.randomUUID(),
      correlationId,
      topic: "flow.item.created",
      timestamp: Date.now(),
      payload: {
        id: `plane-${issue.id}`,
        type: flowItemType,
        status: "queued",
        stage: "backlog",
        createdAt: Date.now(),
        meta: { source: "plane", issueId: issue.id, projectId: issue.project, title: issue.name, priority: issue.priority },
      },
    });

    // The content prefix hints at the skill so agents reading the bus
    // message see what they're being asked to do at a glance.
    const contentPrefix: Record<string, string> = {
      plan: "Plan:",
      bug_triage: "Bug:",
      security_triage: "Security:",
    };
    const prefix = contentPrefix[skillHint] ?? "Plan:";
    bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId,
      topic,
      timestamp: Date.now(),
      payload: {
        planeIssueId: issue.id,
        planeProjectId: issue.project,
        planeWorkspaceId: issue.workspace,
        planeSequenceId: issue.sequence_id,
        title: issue.name,
        description: issue.description_stripped ?? issue.name,
        content: `${prefix} ${issue.name}\n\n${issue.description_stripped ?? issue.name}`,
        priority: issue.priority,
        labels: issue.labels,
        autoApprove,
        skillHint,
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
      `[plane] ${event}.${action} on issue "${issue.name}" (${issue.id}) → ${skillHint}` +
      `${autoApprove ? " (auto-approve)" : ""}`,
    );
  }
}
