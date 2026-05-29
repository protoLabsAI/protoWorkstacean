/**
 * LinearPlugin — Linear webhooks in, outbound Linear mutations out.
 *
 * Inbound:
 *   POST /webhooks/linear → verifies HMAC-SHA256 signature → enforces freshness
 *   window → validates payload via Zod → dedups by delivery id → publishes one of:
 *     message.inbound.linear.issue.{created|updated|removed}
 *     message.inbound.linear.comment.{created|updated|removed}
 *     message.inbound.linear.project.{created|updated|removed}
 *     message.inbound.linear.agent.{issueMention|issueCommentMention|...}
 *     message.inbound.linear.agent_session.{created|prompted}
 *
 *   The HTTP 200 is returned AFTER the bus publish completes, so a publish
 *   failure surfaces as a 5xx that Linear will retry on.
 *
 * Outbound:
 *   linear.reply.{issueId}         → post comment (payload: { text })
 *                                    Result published on
 *                                    linear.reply.result.{correlationId}
 *   linear.update.issue.{issueId}  → mutate issue (payload: { stateName?,
 *                                    priority?, assigneeId?, labelIds? })
 *                                    Result published on
 *                                    linear.update.issue.result.{correlationId}
 *   linear.create.issue            → createIssue (payload: { teamKey, title,
 *                                    description?, priority?, assigneeId?,
 *                                    labelIds?, stateName? })
 *                                    Result published on
 *                                    linear.create.issue.result.{correlationId}
 *
 * Env vars:
 *   LINEAR_API_KEY         Personal API key for outbound mutations (optional;
 *                          without it only inbound webhooks work)
 *   LINEAR_WEBHOOK_SECRET  HMAC-SHA256 signing secret from Linear webhook
 *                          config. REQUIRED in production-like envs (when
 *                          NODE_ENV=production OR WORKSTACEAN_PUBLIC_BASE_URL
 *                          is set). Without it in dev the receiver runs
 *                          unauthenticated and logs loudly.
 *   LINEAR_WEBHOOK_PORT    Port for the webhook server (default: 8084)
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { EventBus, BusMessage, Plugin } from "../types.ts";
import { LinearClient, type LinearPriority } from "../linear-client.ts";
import { getLinearAvaTokenManager } from "../linear/ava-oauth-token-manager.ts";
import { LinearAgentActivityClient } from "../linear/agent-activity-client.ts";

// ── Limits ───────────────────────────────────────────────────────────────────

/** Reject webhook bodies larger than this — Linear's docs cap webhook size at ~1 MB. */
const MAX_BODY_BYTES = 1_048_576;

/**
 * Reject webhook events whose `webhookTimestamp` is older than this. Cuts the
 * replay-attack window when a signed body leaks. Linear's webhookTimestamp is
 * the server-side fire time in ms.
 */
const FRESHNESS_WINDOW_MS = 5 * 60 * 1000;

// ── Linear webhook payload schemas ───────────────────────────────────────────
// Linear sends a single envelope shape for all resource types with a discriminant
// `type` field. We model the fields we publish downstream and validate the
// envelope at the boundary so a Linear API drift produces a loud 4xx instead of
// undefined fields silently flowing through to agents.

const LinearIssueDataSchema = z.object({
  id: z.string(),
  identifier: z.string().optional(),
  title: z.string(),
  description: z.string().optional(),
  priority: z.number().optional(),
  priorityLabel: z.string().optional(),
  state: z.object({ id: z.string(), name: z.string(), type: z.string().optional() }).optional(),
  team: z.object({ id: z.string(), key: z.string(), name: z.string() }).optional(),
  assignee: z.object({ id: z.string(), name: z.string(), email: z.string().optional() }).optional(),
  creator: z.object({ id: z.string(), name: z.string(), email: z.string().optional() }).optional(),
  project: z.object({ id: z.string(), name: z.string() }).optional(),
  labels: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  url: z.string().optional(),
});

const LinearCommentDataSchema = z.object({
  id: z.string(),
  body: z.string(),
  user: z.object({ id: z.string(), name: z.string(), email: z.string().optional() }).optional(),
  issue: z.object({
    id: z.string(),
    identifier: z.string().optional(),
    title: z.string().optional(),
    team: z.object({ id: z.string(), key: z.string() }).optional(),
  }).optional(),
  url: z.string().optional(),
});

const LinearProjectDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  state: z.string().optional(),
  creator: z.object({ id: z.string(), name: z.string() }).optional(),
  url: z.string().optional(),
});

// Linear sends three distinct envelope shapes:
//   1. Standard webhooks (Issue/Comment/Project) — action is create/update/remove
//      or past-tense created/updated/removed. Body in `data`.
//   2. AppUserNotification (Agent app @mentions, assignments, etc.) — action is
//      a camelCase notification verb like issueMention, issueCommentMention,
//      issueAssignedToYou, issueNewComment. Body in `notification`.
//   3. AgentSessionEvent (Agent Session API — newer SDK) — action is created
//      or prompted. Body in `agentSession`.
// We use a permissive envelope (action as string) and branch on `type` in the
// handler. Strict per-shape validation happens after the branch.

const LinearWebhookEnvelopeSchema = z.object({
  action: z.string().min(1),
  type: z.string().min(1),
  data: z.record(z.string(), z.unknown()).optional(),
  notification: z.record(z.string(), z.unknown()).optional(),
  agentSession: z.record(z.string(), z.unknown()).optional(),
  agentActivity: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().optional(),
  organizationId: z.string().optional(),
  webhookTimestamp: z.number().optional(),
  webhookId: z.string().optional(),
});

type LinearWebhookEnvelope = z.infer<typeof LinearWebhookEnvelopeSchema>;

/** Normalize action verb tense. `create` / `created` both → `created`, etc. */
function normalizeAction(action: string): string {
  switch (action) {
    case "create": return "created";
    case "update": return "updated";
    case "remove": return "removed";
    default: return action;
  }
}
type LinearIssueData = z.infer<typeof LinearIssueDataSchema>;
type LinearCommentData = z.infer<typeof LinearCommentDataSchema>;
type LinearProjectData = z.infer<typeof LinearProjectDataSchema>;

// ── Signature verification ───────────────────────────────────────────────────

function verifyLinearSignature(body: Buffer, signature: string, secret: string): boolean {
  // Linear signs requests with HMAC-SHA256 over the raw body; the
  // `linear-signature` header (case-insensitive) is the hex digest.
  // timingSafeEqual throws on length mismatch — catch to return false rather
  // than surfacing an error to the caller.
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Deduplication ring buffer ────────────────────────────────────────────────
// Linear retries on non-2xx. Last 10k IDs in-memory, evicted FIFO.

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

/**
 * Detect production-like environments. When true, we refuse to start without
 * a webhook secret — an unauthenticated public-facing webhook receiver is a
 * footgun that lets anyone inject `message.inbound.linear.*` events.
 */
function isProductionLike(): boolean {
  if (process.env.NODE_ENV === "production") return true;
  if (process.env.WORKSTACEAN_PUBLIC_BASE_URL) return true;
  return false;
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
      if (isProductionLike()) {
        // Fail-loud rather than silently exposing an open webhook receiver in
        // a production-like env.
        throw new Error(
          "[linear] LINEAR_WEBHOOK_SECRET is required when NODE_ENV=production " +
          "or WORKSTACEAN_PUBLIC_BASE_URL is set. Refusing to start an " +
          "unauthenticated webhook receiver in production.",
        );
      }
      console.warn("[linear] LINEAR_WEBHOOK_SECRET not set — signature verification disabled (dev only)");
    }

    const dedup = new DeliveryDedup();
    const client: LinearClient | null = apiKey ? new LinearClient(apiKey) : null;

    // Ava's actor=app client — posts AS Ava (agent activities + plain comments)
    // via her OAuth token, independent of the personal LINEAR_API_KEY. Wired
    // whenever the OAuth app is configured; getAccessToken() throws at call time
    // until the one-time authorize dance is done, which callers catch + log.
    const dataDir = process.env.DATA_DIR || join(process.cwd(), "data");
    const tokenManager = getLinearAvaTokenManager(dataDir);
    const avaClient = tokenManager.isConfigured() ? new LinearAgentActivityClient(tokenManager) : null;
    if (!avaClient) console.warn("[linear] LINEAR_AVA_CLIENT_ID/_SECRET not set — post-as-Ava disabled (replies fall back to personal key)");

    // Outbound comments prefer Ava's identity; create/update still use the
    // personal-key client (team/state resolution lives there).
    if (client || avaClient) this._wireOutbound(bus, client, avaClient);
    else console.warn("[linear] no LINEAR_API_KEY and no Ava OAuth — outbound Linear mutations disabled");

    if (avaClient) this._wireAgentActivity(bus, avaClient);

    try {
      this.server = Bun.serve({
        port,
        fetch: async (req) => {
          const url = new URL(req.url);
          if (url.pathname !== "/webhooks/linear") return new Response("Not found", { status: 404 });
          if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

          // Body-size cap: reject before fully buffering when content-length
          // declares too much. Linear's documented webhook size limit is ~1 MB.
          const declaredLen = parseInt(req.headers.get("content-length") ?? "0", 10);
          if (declaredLen > MAX_BODY_BYTES) {
            return new Response("Payload too large", { status: 413 });
          }
          const bodyBuffer = Buffer.from(await req.arrayBuffer());
          if (bodyBuffer.length > MAX_BODY_BYTES) {
            return new Response("Payload too large", { status: 413 });
          }

          if (webhookSecret) {
            const sig = req.headers.get("linear-signature") ?? "";
            if (!verifyLinearSignature(bodyBuffer, sig, webhookSecret)) {
              console.warn("[linear] Invalid webhook signature — request rejected");
              return new Response("Unauthorized", { status: 401 });
            }
          }

          let raw: unknown;
          try {
            raw = JSON.parse(bodyBuffer.toString("utf-8"));
          } catch {
            return new Response("Bad request: malformed JSON", { status: 400 });
          }

          const parsed = LinearWebhookEnvelopeSchema.safeParse(raw);
          if (!parsed.success) {
            const issues = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ");
            console.warn(`[linear] Webhook envelope failed schema validation — ${issues}`);
            return new Response(`Bad request: ${issues}`, { status: 400 });
          }
          const payload = parsed.data;

          // Replay protection: reject events older than the freshness window.
          // Linear's webhookTimestamp is server-side fire time (ms). Skipped
          // when absent so we don't break against payloads predating the field.
          if (payload.webhookTimestamp != null) {
            const age = Date.now() - payload.webhookTimestamp;
            if (age > FRESHNESS_WINDOW_MS || age < -FRESHNESS_WINDOW_MS) {
              console.warn(
                `[linear] Webhook timestamp outside freshness window ` +
                `(age=${age}ms, max=${FRESHNESS_WINDOW_MS}ms) — request rejected`,
              );
              return new Response("Stale webhook timestamp", { status: 400 });
            }
          }

          // Dedup key — prefer webhookId; fall back to (type, body.id, webhookTimestamp).
          // Each envelope shape (standard / AppUserNotification / AgentSessionEvent)
          // carries its body in a different field; check all three.
          const body = payload.data ?? payload.notification ?? payload.agentSession;
          const dataId = typeof body?.id === "string" ? body.id : "?";
          const dedupKey = payload.webhookId
            ?? `${payload.type}:${payload.action}:${dataId}:${payload.webhookTimestamp ?? 0}`;
          if (dedup.isDuplicate(dedupKey)) {
            return new Response("Already processed", { status: 200 });
          }

          // Await the handler so a publish failure surfaces as a 5xx and
          // Linear retries. Bus publish is microseconds; agents take their
          // time AFTER receiving the message via separate subscribers, so
          // this doesn't block on agent work.
          try {
            await this._handleWebhook(payload, bus);
          } catch (err) {
            console.error("[linear] Webhook handler error — returning 500 for retry:", err);
            return new Response("Internal handler error", { status: 500 });
          }

          return new Response("OK", { status: 200 });
        },
      });
    } catch (err) {
      // Server start failed (port in use, perms, etc.). Fail-loud but don't
      // block the whole process — outbound subscribers are still useful.
      console.error(
        `[linear] Failed to start webhook server on :${port} — inbound disabled. Outbound mutations remain active. Error:`,
        err,
      );
      this.server = null;
      return;
    }

    console.log(`[linear] Webhook receiver on :${port}/webhooks/linear`);
  }

  uninstall(): void {
    this.server?.stop();
    this.server = null;
  }

  private async _handleWebhook(payload: LinearWebhookEnvelope, bus: EventBus): Promise<void> {
    const action = normalizeAction(payload.action);

    if (payload.type === "Issue") {
      if (!payload.data) {
        console.warn(`[linear] Issue webhook missing data field — dropping`);
        return;
      }
      const issueParsed = LinearIssueDataSchema.safeParse(payload.data);
      if (!issueParsed.success) {
        console.warn(`[linear] Issue payload failed schema — dropping. ${issueParsed.error.issues.map(i => i.message).join("; ")}`);
        return;
      }
      this._publishIssue(issueParsed.data, action, bus);
      return;
    }
    if (payload.type === "Comment") {
      if (!payload.data) {
        console.warn(`[linear] Comment webhook missing data field — dropping`);
        return;
      }
      const commentParsed = LinearCommentDataSchema.safeParse(payload.data);
      if (!commentParsed.success) {
        console.warn(`[linear] Comment payload failed schema — dropping. ${commentParsed.error.issues.map(i => i.message).join("; ")}`);
        return;
      }
      this._publishComment(commentParsed.data, action, bus);
      return;
    }
    if (payload.type === "Project") {
      if (!payload.data) {
        console.warn(`[linear] Project webhook missing data field — dropping`);
        return;
      }
      const projectParsed = LinearProjectDataSchema.safeParse(payload.data);
      if (!projectParsed.success) {
        console.warn(`[linear] Project payload failed schema — dropping. ${projectParsed.error.issues.map(i => i.message).join("; ")}`);
        return;
      }
      this._publishProject(projectParsed.data, action, bus);
      return;
    }
    if (payload.type === "AppUserNotification") {
      // Agent app events: @mentions, assignments, comments on assigned issues, etc.
      // Body is in `notification`. Pass the raw object through — downstream
      // routing decides what to do with each notification kind.
      this._publishAgentNotification(payload.action, payload.notification ?? {}, bus);
      return;
    }
    if (payload.type === "AgentSessionEvent") {
      // Linear's newer Agent Session API. Body is in `agentSession` plus
      // optionally `agentActivity` (for prompted events).
      this._publishAgentSession(payload.action, payload.agentSession ?? {}, payload.agentActivity, bus);
      return;
    }
    // Unknown envelope type — log loudly + drop. Linear adds new resource
    // types over time; fail visibly so we know to extend the plugin.
    console.warn(`[linear] Unhandled webhook type "${payload.type}" action="${payload.action}" — dropping (extend LinearPlugin to support)`);
  }

  private _publishAgentNotification(action: string, notification: Record<string, unknown>, bus: EventBus): void {
    const topic = `message.inbound.linear.agent.${action}`;
    const issueId = (notification.issueId as string | undefined)
      ?? ((notification.issue as { id?: string } | undefined)?.id);
    const commentId = (notification.commentId as string | undefined)
      ?? ((notification.comment as { id?: string } | undefined)?.id);
    const correlationId = issueId ? `linear-${issueId}` : crypto.randomUUID();
    bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId,
      topic,
      timestamp: Date.now(),
      payload: {
        action,
        notification,
        issueId,
        commentId,
      },
    });
    console.log(`[linear] agent.${action}${issueId ? ` on issue ${issueId}` : ""}`);
  }

  private _publishAgentSession(
    action: string,
    agentSession: Record<string, unknown>,
    agentActivity: Record<string, unknown> | undefined,
    bus: EventBus,
  ): void {
    const topic = `message.inbound.linear.agent_session.${action}`;
    const sessionId = agentSession.id as string | undefined;
    const issueId = (agentSession.issueId as string | undefined)
      ?? ((agentSession.issue as { id?: string } | undefined)?.id);
    const correlationId = sessionId ?? (issueId ? `linear-${issueId}` : crypto.randomUUID());
    bus.publish(topic, {
      id: crypto.randomUUID(),
      correlationId,
      topic,
      timestamp: Date.now(),
      payload: {
        // Route agent-session events to Ava's Linear handler. Without an
        // explicit hint the router has no skill to resolve (no keyword content)
        // and drops the event — so assigning Ava to a ticket silently no-ops.
        skillHint: "linear_agent_respond",
        action,
        sessionId,
        issueId,
        agentSession,
        agentActivity,
      },
      // Ava's dispatch result rounds back here → a `response` agent-activity in
      // the session (posted AS Ava), not a comment. Only when we have a
      // sessionId to target.
      ...(sessionId
        ? { reply: { topic: `linear.agent_activity.${sessionId}`, format: "markdown" as const } }
        : {}),
    });
    console.log(`[linear] agent_session.${action}${sessionId ? ` session=${sessionId}` : ""}`);
  }

  // ── Agent-session activities (post AS Ava via actor=app OAuth) ──────────────
  //
  // Two halves:
  //   1. On agent_session.created AND .prompted, emit a `thought` within 10s so
  //      Linear doesn't mark the session unresponsive (the agent's full run is
  //      slower than 10s). Linear sends `created` on assignment and `prompted`
  //      on every follow-up comment — both need the fast ack, or the session
  //      shows "did not respond" on each comment whose run runs long.
  //   2. linear.agent_activity.{sessionId} (the reply.topic set on agent-session
  //      dispatches) → emit Ava's final text as a `response` activity.
  private _wireAgentActivity(bus: EventBus, activity: LinearAgentActivityClient): void {
    // 1. 10-second thought ack on session start AND every follow-up prompt.
    bus.subscribe("message.inbound.linear.agent_session.#", "linear-agent-activity", (msg: BusMessage) => {
      const topic = msg.topic ?? "";
      // created → assignment; prompted → a follow-up comment. Both need the ack.
      if (!topic.endsWith(".created") && !topic.endsWith(".prompted")) return;
      const sessionId = (msg.payload as { sessionId?: string })?.sessionId;
      if (!sessionId) return;
      const ack = topic.endsWith(".created")
        ? "On it — taking a look and routing this."
        : "Got it — looking at that now.";
      void activity.thought(sessionId, ack).catch((err) => {
        console.error(`[linear] agent-activity thought ack failed (session ${sessionId}): ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    // 2. Ava's dispatch result → a `response` activity.
    bus.subscribe("linear.agent_activity.#", "linear-agent-activity", (msg: BusMessage) => {
      const topic = msg.topic ?? "";
      if (topic.startsWith("linear.agent_activity.result.")) return; // don't re-enter on our own result
      const sessionId = topic.startsWith("linear.agent_activity.")
        ? topic.slice("linear.agent_activity.".length)
        : "";
      if (!sessionId) return;
      const payload = (msg.payload ?? {}) as { text?: string; content?: string; summary?: string };
      const body = payload.text ?? payload.content ?? payload.summary ?? "";
      if (!body) return;
      void activity.response(sessionId, body)
        .then(() => {
          publishResult(bus, msg.correlationId, "linear.agent_activity.result", { success: true, sessionId });
          console.log(`[linear] response activity posted to session ${sessionId}`);
        })
        .catch((err) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          publishResult(bus, msg.correlationId, "linear.agent_activity.result", { success: false, sessionId, error: errMsg });
          console.error(`[linear] response activity failed (session ${sessionId}): ${errMsg}`);
        });
    });
  }

  private _publishIssue(issue: LinearIssueData, action: string, bus: EventBus): void {
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
        // teamKey is the channel identifier — channels.yaml entries declare
        // per-team agents (or per-issue / per-project), and RouterPlugin
        // resolves channel → agent.
        channelId: issue.team?.key ?? issue.id,
        userId: issue.creator?.id,
      },
      reply: {
        topic: `linear.reply.${issue.id}`,
        // Linear comment bodies render markdown.
        format: "markdown",
      },
    });
    console.log(`[linear] issue.${action} ${issue.identifier ?? issue.id} "${issue.title}"`);
  }

  private _publishComment(comment: LinearCommentData, action: string, bus: EventBus): void {
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
        format: "markdown",
      },
    });
    console.log(`[linear] comment.${action} on ${comment.issue?.identifier ?? issueId}`);
  }

  private _publishProject(project: LinearProjectData, action: string, bus: EventBus): void {
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
  }

  // ── Outbound ───────────────────────────────────────────────────────────────
  //
  // Every outbound mutation publishes a result topic
  // `linear.{verb}.result.{correlationId}` carrying { success, error?, ... }
  // so callers (agents) can confirm their action landed instead of silently
  // assuming success.

  private _wireOutbound(bus: EventBus, client: LinearClient | null, avaClient: LinearAgentActivityClient | null): void {
    // linear.reply.{issueId} — post a comment using the standard
    // reply-on-topic convention agents already know. Prefer Ava's actor=app
    // token so the comment is authored AS Ava; fall back to the personal-key
    // client if she isn't authorized or her post fails.
    bus.subscribe("linear.reply.#", "linear-outbound", async (msg: BusMessage) => {
      const topic = msg.topic ?? "";
      // Result topics from this family must not re-enter this subscriber.
      if (topic.startsWith("linear.reply.result.")) return;
      const issueId = topic.startsWith("linear.reply.") ? topic.slice("linear.reply.".length) : "";
      if (!issueId) {
        publishResult(bus, msg.correlationId, "linear.reply.result", {
          success: false,
          error: "missing issueId in topic",
        });
        return;
      }
      const payload = (msg.payload ?? {}) as { text?: string; content?: string; summary?: string };
      const body = payload.text ?? payload.content ?? payload.summary ?? "";
      if (!body) {
        publishResult(bus, msg.correlationId, "linear.reply.result", {
          success: false,
          issueId,
          error: "empty body",
        });
        return;
      }
      // 1) As Ava (actor=app token) when authorized.
      if (avaClient?.isReady()) {
        try {
          await avaClient.createComment(issueId, body);
          publishResult(bus, msg.correlationId, "linear.reply.result", { success: true, issueId, as: "ava" });
          console.log(`[linear] Comment posted AS Ava on issue ${issueId}`);
          return;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.warn(`[linear] post-as-Ava comment failed on ${issueId} (${errMsg}) — falling back to personal key`);
        }
      }
      // 2) Fall back to the personal-key client.
      if (!client) {
        publishResult(bus, msg.correlationId, "linear.reply.result", {
          success: false, issueId, error: "no Ava token and no LINEAR_API_KEY — cannot post comment",
        });
        console.error(`[linear] cannot post comment on ${issueId} — no Ava token and no personal key`);
        return;
      }
      try {
        const ok = await client.addComment(issueId, body);
        publishResult(bus, msg.correlationId, "linear.reply.result", {
          success: ok,
          issueId,
          as: "personal-key",
          error: ok ? undefined : "client.addComment returned false",
        });
        if (ok) console.log(`[linear] Comment posted (personal key) on issue ${issueId}`);
        else console.warn(`[linear] Failed to post comment on issue ${issueId}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        publishResult(bus, msg.correlationId, "linear.reply.result", {
          success: false,
          issueId,
          error: errMsg,
        });
        console.error(`[linear] Comment exception on issue ${issueId}: ${errMsg}`);
      }
    });

    // linear.update.issue.{issueId} — state / priority / assignee / labels
    bus.subscribe("linear.update.issue.#", "linear-outbound", async (msg: BusMessage) => {
      const topic = msg.topic ?? "";
      // Result topics are linear.update.issue.result.{correlationId} — skip
      // to avoid re-entering this subscriber.
      if (topic.startsWith("linear.update.issue.result.")) return;
      if (!client) {
        publishResult(bus, msg.correlationId, "linear.update.issue.result", {
          success: false, error: "LINEAR_API_KEY not set — issue mutations disabled",
        });
        return;
      }
      const issueId = topic.startsWith("linear.update.issue.")
        ? topic.slice("linear.update.issue.".length)
        : "";
      if (!issueId) {
        publishResult(bus, msg.correlationId, "linear.update.issue.result", {
          success: false,
          error: "missing issueId in topic",
        });
        return;
      }
      const payload = (msg.payload ?? {}) as {
        stateName?: string;
        priority?: LinearPriority;
        assigneeId?: string;
        labelIds?: string[];
      };
      try {
        const result = await client.updateIssue(issueId, payload);
        publishResult(bus, msg.correlationId, "linear.update.issue.result", {
          success: result.success,
          issueId,
          error: result.success ? undefined : result.reason,
        });
        if (result.success) {
          console.log(`[linear] Issue ${issueId} updated: ${JSON.stringify(payload)}`);
        } else {
          console.warn(`[linear] Issue ${issueId} update skipped: ${result.reason}`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        publishResult(bus, msg.correlationId, "linear.update.issue.result", {
          success: false,
          issueId,
          error: errMsg,
        });
        console.error(`[linear] Issue ${issueId} update exception: ${errMsg}`);
      }
    });

    // linear.create.issue — creates in the named team and publishes the new
    // issue id back on linear.create.issue.result.{correlationId} so agents
    // can await their own creations.
    bus.subscribe("linear.create.issue", "linear-outbound", async (msg: BusMessage) => {
      if (!client) {
        publishResult(bus, msg.correlationId, "linear.create.issue.result", {
          success: false, error: "LINEAR_API_KEY not set — issue creation disabled",
        });
        return;
      }
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
        publishResult(bus, msg.correlationId, "linear.create.issue.result", {
          success: false,
          error: "missing teamKey or title",
        });
        console.warn("[linear] linear.create.issue missing teamKey or title — skipping");
        return;
      }
      try {
        const newId = await client.createIssue({
          teamKey: payload.teamKey,
          title: payload.title,
          description: payload.description,
          priority: payload.priority,
          assigneeId: payload.assigneeId,
          labelIds: payload.labelIds,
          stateName: payload.stateName,
        });
        publishResult(bus, msg.correlationId, "linear.create.issue.result", {
          success: newId !== null,
          issueId: newId,
          error: newId === null ? `team '${payload.teamKey}' not found or createIssue failed` : undefined,
        });
        if (newId) console.log(`[linear] Created issue ${newId} in team ${payload.teamKey}`);
        else console.warn(`[linear] Failed to create issue in team ${payload.teamKey}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        publishResult(bus, msg.correlationId, "linear.create.issue.result", {
          success: false,
          error: errMsg,
        });
        console.error(`[linear] Create issue exception in team ${payload.teamKey}: ${errMsg}`);
      }
    });
  }
}

/**
 * Publish a `{family}.{correlationId}` result event when a correlationId is
 * set. No-op without one (caller didn't ask for confirmation).
 */
function publishResult(
  bus: EventBus,
  correlationId: string | undefined,
  family: string,
  payload: Record<string, unknown>,
): void {
  if (!correlationId) return;
  const topic = `${family}.${correlationId}`;
  bus.publish(topic, {
    id: crypto.randomUUID(),
    correlationId,
    topic,
    timestamp: Date.now(),
    payload,
  });
}
