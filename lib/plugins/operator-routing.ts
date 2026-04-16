/**
 * OperatorRoutingPlugin — abstracts operator-bound messages from the transport
 * (Discord, SMS, Signal, email, etc.) so any agent can call `msg_operator`
 * without knowing which channel the operator is currently reachable on.
 *
 * Today's routing: single channel (Discord DM). Operator identity is sourced
 * from workspace/users.yaml via IdentityRegistry — the first admin user with
 * a Discord ID mapped is the recipient. If no admin has a Discord ID, each
 * route throws: agents see a tool-call error in their ReAct loop (NOT a
 * silent drop). Fail loud.
 *
 * Future routing: a `operator_presence` world-state domain will track live
 * signals (active-on-discord, on-phone, AFK, GPS pinned to home/office, etc).
 * This plugin will consult that domain + a per-channel config to pick the
 * right surface — DM when they're on Discord, SMS when AFK > 30min, pager
 * duty when urgency=urgent and nothing else responds within a TTL, etc.
 *
 * Abstraction contract:
 *   - Agents publish `operator.message.request` with an OperatorMessageRequest
 *     payload (content + urgency + topic + from).
 *   - This plugin picks channel(s) and publishes channel-specific topics:
 *     - Discord DM: `message.outbound.discord.dm.user.{userId}`
 *     - (Future) SMS: `message.outbound.sms.{phoneE164}`
 *     - (Future) Signal: `message.outbound.signal.{number}`
 *     - (Future) Push: `message.outbound.push.{deviceToken}`
 *   - Transport plugins subscribe to their own topic and own the delivery.
 *   - Adding a new channel = one new subscriber, no changes here.
 *
 * Failure semantics: if no channel can be chosen, this plugin throws. The
 * HTTP layer at /api/operator/message catches and returns 503 so the tool
 * call visibly fails. See feedback_fail_fast_and_loud memory.
 */

import type { EventBus, BusMessage, Plugin } from "../types.ts";
import type { IdentityRegistry } from "../identity/identity-registry.ts";

/** Thrown when the plugin has no transport available for the operator. */
export class OperatorUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorUnreachableError";
  }
}

export interface OperatorMessageRequest {
  type: "operator_message_request";
  correlationId: string;
  /** The message body to deliver to the operator. */
  message: string;
  /**
   * Urgency. Today all urgencies use the same channel; future routing will
   * gate channels by urgency floor (e.g. SMS only for high+).
   */
  urgency: "low" | "normal" | "high" | "urgent";
  /** What the message is about — for subject lines / grouping. */
  topic?: string;
  /** Agent name that originated the request (for attribution + rate limiting). */
  from: string;
}

export class OperatorRoutingPlugin implements Plugin {
  readonly name = "operator-routing";
  readonly description =
    "Routes operator-bound messages across transports (Discord, SMS, etc.) based on presence + urgency";
  readonly capabilities = ["operator-routing"];

  /**
   * IdentityRegistry is the single source of truth for operator identity.
   * The first admin user with a Discord identity in workspace/users.yaml is
   * the DM recipient. No env var fallback — if no admin has a Discord ID
   * mapped, route() throws OperatorUnreachableError.
   */
  constructor(private readonly identityRegistry: IdentityRegistry) {}

  install(bus: EventBus): void {
    bus.subscribe("operator.message.request", this.name, (msg: BusMessage) => {
      const req = msg.payload as OperatorMessageRequest;
      if (req?.type !== "operator_message_request") return;
      try {
        this._route(bus, req);
      } catch (err) {
        // Bus subscribers can't throw back to the publisher, so publish a
        // failure event on a correlationId-scoped topic. Synchronous HTTP
        // callers (the tool handler) subscribe to this and surface the
        // error to the agent's ReAct loop.
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(
          `[operator-routing] FAILED to route message from ${req.from}: ${errMsg}`,
        );
        bus.publish(`operator.message.failed.${req.correlationId}`, {
          id: crypto.randomUUID(),
          correlationId: req.correlationId,
          topic: `operator.message.failed.${req.correlationId}`,
          timestamp: Date.now(),
          payload: {
            type: "operator_message_failed",
            correlationId: req.correlationId,
            error: errMsg,
          },
        });
      }
    });
  }

  uninstall(): void {}

  /**
   * Decide which channel(s) deliver the message. Single-channel today
   * (Discord DM via the admin user in users.yaml). Designed to branch here
   * when the presence domain and channel config land.
   *
   * Throws OperatorUnreachableError when no channel is available — never
   * drops silently. The install() wrapper catches + publishes a
   * `operator.message.failed.{correlationId}` event so HTTP callers surface
   * the failure to the agent's ReAct loop.
   */
  private _route(bus: EventBus, req: OperatorMessageRequest): void {
    const discordUserId = this.identityRegistry.adminIds("discord")[0];
    const delivered: string[] = [];

    if (discordUserId) {
      const prefix = req.topic ? `**[${req.topic}]** ` : "";
      const urgencyBadge = req.urgency === "urgent" ? "🚨 " : req.urgency === "high" ? "⚠️ " : "";
      const attribution = req.from ? `\n_— ${req.from}_` : "";
      const content = `${urgencyBadge}${prefix}${req.message}${attribution}`;

      const topic = `message.outbound.discord.dm.user.${discordUserId}`;
      bus.publish(topic, {
        id: crypto.randomUUID(),
        correlationId: req.correlationId,
        topic,
        timestamp: Date.now(),
        payload: { content, agentId: req.from, urgency: req.urgency },
      });
      delivered.push("discord-dm");
    }

    if (delivered.length === 0) {
      throw new OperatorUnreachableError(
        "No operator channels available — configure workspace/users.yaml with an admin user and a Discord identity (identities.discord)",
      );
    }

    console.log(
      `[operator-routing] Delivered message from ${req.from} via ${delivered.join(", ")} (urgency=${req.urgency}, topic=${req.topic ?? "none"})`,
    );
  }
}
