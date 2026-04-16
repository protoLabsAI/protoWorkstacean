/**
 * OperatorRoutingPlugin — abstracts operator-bound messages from the transport
 * (Discord, SMS, Signal, email, etc.) so any agent can call `msg_operator`
 * without knowing which channel the operator is currently reachable on.
 *
 * Today's routing: single channel (Discord DM) if the first admin user in
 * workspace/users.yaml has a Discord ID mapped. If not, each request is
 * dropped with a visible warning — agents shouldn't silently fail to reach
 * the operator.
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
 */

import type { EventBus, BusMessage, Plugin } from "../types.ts";
import type { IdentityRegistry } from "../identity/identity-registry.ts";

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
   * mapped, operator messaging is disabled and each request is dropped with
   * a visible warning.
   */
  constructor(private readonly identityRegistry: IdentityRegistry) {}

  install(bus: EventBus): void {
    bus.subscribe("operator.message.request", this.name, (msg: BusMessage) => {
      const req = msg.payload as OperatorMessageRequest;
      if (req?.type !== "operator_message_request") return;
      this._route(bus, req);
    });
  }

  uninstall(): void {}

  /**
   * Decide which channel(s) deliver the message. Single-channel today
   * (Discord DM when OPERATOR_DISCORD_USER_ID is set). Designed to branch
   * here when the presence domain and channel config land.
   */
  private _route(bus: EventBus, req: OperatorMessageRequest): void {
    // Operator identity is sourced from workspace/users.yaml — the first
    // admin user with a Discord ID mapped. If none, we drop the message.
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
      console.warn(
        `[operator-routing] No channels configured — dropped message from ${req.from} (urgency=${req.urgency}): "${req.message.slice(0, 100)}"`,
      );
      return;
    }

    console.log(
      `[operator-routing] Delivered message from ${req.from} via ${delivered.join(", ")} (urgency=${req.urgency}, topic=${req.topic ?? "none"})`,
    );
  }
}
