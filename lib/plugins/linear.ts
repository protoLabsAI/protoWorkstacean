/**
 * LinearPlugin — Linear webhooks in, outbound Linear mutations out.
 *
 * Inbound:
 *   POST /webhooks/linear → verifies HMAC-SHA256 signature → dedups by
 *   delivery id → publishes one of:
 *     message.inbound.linear.issue.{created|updated|removed}
 *     message.inbound.linear.comment.{created|updated|removed}
 *     message.inbound.linear.project.{created|updated|removed}
 *
 * RouterPlugin already subscribes to `message.inbound.#` and translates to
 * `agent.skill.request` — Linear channels configured in
 * workspace/channels.yaml (platform: linear, teamKey / issueId / projectId)
 * route to the appropriate agent + skill.
 *
 * Outbound:
 *   linear.reply.{issueId}        → post comment (payload: { text })
 *   linear.update.issue.{issueId} → mutate issue (payload: { stateName?,
 *                                   priority?, assigneeId?, labelIds? })
 *   linear.create.issue            → createIssue (payload: { teamKey, title,
 *                                   description?, priority?, assigneeId?,
 *                                   labelIds?, stateName? })
 *                                   Result published back on
 *                                   linear.create.issue.result.{correlationId}
 *
 * Env vars:
 *   LINEAR_API_KEY         Personal API key for outbound mutations (optional;
 *                          without it only inbound webhooks work)
 *   LINEAR_WEBHOOK_SECRET  HMAC-SHA256 signing secret from Linear webhook
 *                          config (optional in dev — unset disables verification)
 *   LINEAR_WEBHOOK_PORT    Port for the webhook server (default: 8084)
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { EventBus, BusMessage, Plugin } from "../types.ts";
import { LinearClient, type LinearPriority } from "../linear-client.ts";

// ── Linear webhook payload shapes ────────────────────────────────────────────
// Linear sends a single envelope shape for all resource types with a discriminant
// `type` field. We only model the fields we actually publish downstream; any
// extra fields flow through untouched via the raw payload.

interface LinearWebhookIssueData {
  id: string;
  identifier?: string;
  title: string;
  description?: string;
  priority?: number;
  priorityLabel?: string;
  state?: { id: string; name: string; type?: string };
  team?: { id: string; key: string; name: string };
  assignee?: { id: string; name: string; email?: string };
  creator?: { id: string; name: string; email?: string };
  project?: { id: string; name: string };
  labels?: Array<{ id: string; name: string }>;
  url?: string;
}

interface LinearWebhookCommentData {
  id: string;
  body: string;
  user?: { id: string; name: string; email?: string };
  issue?: { id: string; identifier?: string; title?: string; team?: { id: string; key: string } };
  url?: string;
}

interface LinearWebhookProjectData {
  id: string;
  name: string;
  description?: string;
  state?: string;
  creator?: { id: string; name: string };
  url?: string;
}

type LinearWebhookData = LinearWebhookIssueData | LinearWebhookCommentData | LinearWebhookProjectData;

interface LinearWebhookEnvelope {
  action: "create" | "update" | "remove";
  type: "Issue" | "Comment" | "Project" | string;
  data: LinearWebhookData;
  createdAt?: string;
  organizationId?: string;
  webhookTimestamp?: number;
  webhookId?: string;
}

// ── Signature verification ───────────────────────────────────────────────────

function verifyLinearSignature(body: Buffer, signature: string, secret: string): boolean {
  // Linear signs requests with HMAC-SHA256 over the raw body; the `linear-signature`
  // header is the hex digest. timingSafeEqual throws on length mismatch — catch
  // to return false rather than surfacing an error to the caller.
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Deduplication ring buffer ────────────────────────────────────────────────
// Linear retries on non-2xx. Standard ring-buffer dedup — last 10k IDs
// in-memory, evicted FIFO. Keyed on the webhook envelope's webhookTimestamp +
// data.id when present; falls back to a stable hash of the body.

class DeliveryDedup {
  private seen = new Set<string>();
  private order: string[] = [];
  private readonly maxSize: number;

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

// Map Linear's 0-4 priority ints back to the string enum the bus uses so
// downstream consumers see consistent priority values regardless of source.
function priorityToString(p?: number): LinearPriority {
  switch (p) {
    case 1: return "urgent";
    case 2: return "high";
    case 3: return "medium";
    case 4: return "low";
    default: return "none";
  }
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class LinearPlugin implements Plugin {
  readonly name = "linear";
  readonly description = "Linear webhook receiver — issue/comment events → bus, outbound mutations";
  readonly capabilities = ["linear-inbound", "linear-outbound"];

  private server: ReturnType<typeof Bun.serve> | null = null;

  install(bus: EventBus): void {
    const webhookSecret = process.env.LINEAR_WEBHOOK_SECRET ?? "";
    const apiKey = process.env.LINEAR_API_KEY ?? "";
    const port = parseInt(process.env.LINEAR_WEBHOOK_PORT ?? "8084", 10);

    if (!webhookSecret) {
      console.warn("[linear] LINEAR_WEBHOOK_SECRET not set — signature verification disabled (dev mode)");
    }

    const dedup = new DeliveryDedup();
    const client: LinearClient | null = apiKey ? new LinearClient(apiKey) : null;

    if (client) this._wireOutbound(bus, client);
    else console.warn("[linear] LINEAR_API_KEY not set — outbound Linear mutations disabled");

    this.server = Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname !== "/webhooks/linear") return new Response("Not found", { status: 404 });
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

        const bodyBuffer = Buffer.from(await req.arrayBuffer());

        if (webhookSecret) {
          const sig = req.headers.get("linear-signature") ?? "";
          if (!verifyLinearSignature(bodyBuffer, sig, webhookSecret)) {
            console.warn("[linear] Invalid webhook signature — request rejected");
            return new Response("Unauthorized", { status: 401 });
          }
        }

        let payload: LinearWebhookEnvelope;
        try {
          payload = JSON.parse(bodyBuffer.toString("utf-8")) as LinearWebhookEnvelope;
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        // Dedup key — prefer webhookId; fall back to (type, data.id, webhookTimestamp)
        // so retries of the same event are collapsed even when Linear's id
        // rotation behavior differs.
        const dedupKey = payload.webhookId
          ?? `${payload.type}:${payload.data?.id ?? "?"}:${payload.webhookTimestamp ?? 0}`;
        if (dedup.isDuplicate(dedupKey)) {
          return new Response("Already processed", { status: 200 });
        }

        // Fire and forget — Linear expects a 2xx within seconds; downstream
        // bus handlers can take their time.
        this._handleWebhook(payload, bus).catch(err => {
          console.error("[linear] Webhook handler error:", err);
        });

        return new Response("OK", { status: 200 });
      },
    });

    console.log(`[linear] Webhook receiver on :${port}/webhooks/linear`);
  }

  uninstall(): void {
    this.server?.stop();
    this.server = null;
  }

  private _handleWebhook(payload: LinearWebhookEnvelope, bus: EventBus): Promise<void> {
    const actionMap: Record<LinearWebhookEnvelope["action"], string> = {
      create: "created",
      update: "updated",
      remove: "removed",
    };
    const action = actionMap[payload.action];
    if (!action) return Promise.resolve();

    if (payload.type === "Issue") {
      return this._publishIssue(payload.data as LinearWebhookIssueData, action, bus);
    }
    if (payload.type === "Comment") {
      return this._publishComment(payload.data as LinearWebhookCommentData, action, bus);
    }
    if (payload.type === "Project") {
      return this._publishProject(payload.data as LinearWebhookProjectData, action, bus);
    }
    // Unknown envelope type — log once and drop. Linear adds new resource
    // types over time; we don't want to spam the bus with shapes consumers
    // aren't ready for.
    console.log(`[linear] Unhandled webhook type "${payload.type}" — ignoring`);
    return Promise.resolve();
  }

  private _publishIssue(issue: LinearWebhookIssueData, action: string, bus: EventBus): Promise<void> {
    const topic = `message.inbound.linear.issue.${action}`;
    const correlationId = `linear-${issue.id}`;
    bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId,
      topic,
      timestamp: Date.now(),
      payload: {
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? "",
        content: issue.description ? `${issue.title}\n\n${issue.description}` : issue.title,
        priority: priorityToString(issue.priority),
        priorityLabel: issue.priorityLabel,
        state: issue.state?.name,
        stateType: issue.state?.type,
        teamKey: issue.team?.key,
        teamId: issue.team?.id,
        projectId: issue.project?.id,
        projectName: issue.project?.name,
        assigneeId: issue.assignee?.id,
        assigneeName: issue.assignee?.name,
        creatorId: issue.creator?.id,
        creatorName: issue.creator?.name,
        labels: (issue.labels ?? []).map(l => l.name),
        url: issue.url,
      },
      source: {
        interface: "linear" as const,
        // Use teamKey as the channel identifier — channels.yaml entries
        // declare per-team agents, per-issue agents, or per-project agents,
        // and RouterPlugin resolves channel → agent using any of these.
        channelId: issue.team?.key ?? issue.id,
        userId: issue.creator?.id,
      },
      reply: {
        topic: `linear.reply.${issue.id}`,
        format: "structured",
      },
    });
    console.log(`[linear] issue.${action} ${issue.identifier ?? issue.id} "${issue.title}"`);
    return Promise.resolve();
  }

  private _publishComment(comment: LinearWebhookCommentData, action: string, bus: EventBus): Promise<void> {
    const topic = `message.inbound.linear.comment.${action}`;
    const issueId = comment.issue?.id ?? "";
    const correlationId = `linear-${issueId}`;
    bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId,
      topic,
      timestamp: Date.now(),
      payload: {
        commentId: comment.id,
        issueId,
        issueIdentifier: comment.issue?.identifier,
        issueTitle: comment.issue?.title,
        teamKey: comment.issue?.team?.key,
        body: comment.body,
        content: comment.body,
        userId: comment.user?.id,
        userName: comment.user?.name,
        url: comment.url,
      },
      source: {
        interface: "linear" as const,
        channelId: comment.issue?.team?.key ?? issueId,
        userId: comment.user?.id,
      },
      reply: {
        topic: `linear.reply.${issueId}`,
        format: "structured",
      },
    });
    console.log(`[linear] comment.${action} on ${comment.issue?.identifier ?? issueId}`);
    return Promise.resolve();
  }

  private _publishProject(project: LinearWebhookProjectData, action: string, bus: EventBus): Promise<void> {
    const topic = `message.inbound.linear.project.${action}`;
    const correlationId = `linear-project-${project.id}`;
    bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId,
      topic,
      timestamp: Date.now(),
      payload: {
        projectId: project.id,
        name: project.name,
        description: project.description ?? "",
        state: project.state,
        creatorId: project.creator?.id,
        creatorName: project.creator?.name,
        url: project.url,
      },
      source: {
        interface: "linear" as const,
        channelId: project.id,
        userId: project.creator?.id,
      },
    });
    console.log(`[linear] project.${action} "${project.name}" (${project.id})`);
    return Promise.resolve();
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  private _wireOutbound(bus: EventBus, client: LinearClient): void {
    // linear.reply.{issueId} — post a comment using the standard
    // reply-on-topic convention agents already know.
    bus.subscribe("linear.reply.#", "linear-outbound", async (msg: BusMessage) => {
      const topic = msg.topic ?? "";
      const issueId = topic.startsWith("linear.reply.") ? topic.slice("linear.reply.".length) : "";
      if (!issueId) {
        console.warn("[linear] linear.reply.* missing issueId in topic — skipping");
        return;
      }
      const payload = (msg.payload ?? {}) as { text?: string; content?: string; summary?: string };
      const body = payload.text ?? payload.content ?? payload.summary ?? "";
      if (!body) {
        console.warn(`[linear] linear.reply.${issueId} has empty body — skipping`);
        return;
      }
      const ok = await client.addComment(issueId, body);
      if (ok) console.log(`[linear] Comment posted on issue ${issueId}`);
      else console.warn(`[linear] Failed to post comment on issue ${issueId}`);
    });

    // linear.update.issue.{issueId} — state / priority / assignee / labels
    bus.subscribe("linear.update.issue.#", "linear-outbound", async (msg: BusMessage) => {
      const topic = msg.topic ?? "";
      const issueId = topic.startsWith("linear.update.issue.")
        ? topic.slice("linear.update.issue.".length)
        : "";
      if (!issueId) return;
      const payload = (msg.payload ?? {}) as {
        stateName?: string;
        priority?: LinearPriority;
        assigneeId?: string;
        labelIds?: string[];
      };
      const ok = await client.updateIssue(issueId, payload);
      if (ok) console.log(`[linear] Issue ${issueId} updated: ${JSON.stringify(payload)}`);
    });

    // linear.create.issue — creates in the named team and publishes the new
    // issue id back on linear.create.issue.result.{correlationId} so agents
    // can await their own creations.
    bus.subscribe("linear.create.issue", "linear-outbound", async (msg: BusMessage) => {
      const payload = (msg.payload ?? {}) as {
        teamKey?: string;
        title?: string;
        description?: string;
        priority?: LinearPriority;
        assigneeId?: string;
        labelIds?: string[];
        stateName?: string;
      };
      if (!payload.teamKey || !payload.title) {
        console.warn("[linear] linear.create.issue missing teamKey or title — skipping");
        return;
      }
      const newId = await client.createIssue({
        teamKey: payload.teamKey,
        title: payload.title,
        description: payload.description,
        priority: payload.priority,
        assigneeId: payload.assigneeId,
        labelIds: payload.labelIds,
        stateName: payload.stateName,
      });
      if (msg.correlationId) {
        const resultTopic = `linear.create.issue.result.${msg.correlationId}`;
        bus.publish(resultTopic, {
          id: crypto.randomUUID(),
          correlationId: msg.correlationId,
          topic: resultTopic,
          timestamp: Date.now(),
          payload: { success: newId !== null, issueId: newId },
        });
      }
      if (newId) console.log(`[linear] Created issue ${newId} in team ${payload.teamKey}`);
      else console.warn(`[linear] Failed to create issue in team ${payload.teamKey}`);
    });
  }
}
