/**
 * outbound.ts — Reply handling, HITL rendering, and outbound bus subscription.
 *
 * Owns the pendingReplies map (written by inbound/slash-commands, consumed here).
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import type { BusMessage, HITLRequest } from "../../types.ts";
import type { DiscordContext } from "./core.ts";

// ── Pending reply handles ─────────────────────────────────────────────────────
// Kept outside bus payload so the SQLite logger never tries to serialize them.

export const pendingReplies = new Map<
  string,
  { message?: Message; interaction?: ChatInputCommandInteraction }
>();

// ── Progress update throttle ──────────────────────────────────────────────────

const progressLastSent = new Map<string, number>();
const PROGRESS_MIN_INTERVAL_MS = 5_000;

export function canSendProgress(correlationId: string): boolean {
  const last = progressLastSent.get(correlationId) ?? 0;
  if (Date.now() - last < PROGRESS_MIN_INTERVAL_MS) return false;
  progressLastSent.set(correlationId, Date.now());
  return true;
}

// ── HITL embed/button builders ────────────────────────────────────────────────

export function buildHITLEmbed(request: HITLRequest): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(request.title)
    .setDescription(request.summary.slice(0, 4096))
    .setColor(0xf59e0b);

  if (request.avaVerdict) {
    embed.addFields({
      name: `Ava verdict (score: ${request.avaVerdict.score})`,
      value: request.avaVerdict.verdict.slice(0, 1024),
      inline: false,
    });
  }
  if (request.jonVerdict) {
    embed.addFields({
      name: `Jon verdict (score: ${request.jonVerdict.score})`,
      value: request.jonVerdict.verdict.slice(0, 1024),
      inline: false,
    });
  }
  if (request.escalationContext) {
    const ctx = request.escalationContext;
    embed.addFields({
      name: "Cost",
      value: `Est: **$${ctx.estimatedCost.toFixed(4)}** | Max: $${ctx.maxCost.toFixed(4)} | Tier: ${ctx.tier}`,
      inline: false,
    });
  }

  embed.setFooter({ text: `Expires ${new Date(request.expiresAt).toLocaleString()}` });
  return embed;
}

export function buildHITLButtons(request: HITLRequest): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  const STYLE_BY_OPTION: Record<string, ButtonStyle> = {
    approve: ButtonStyle.Success,
    reject: ButtonStyle.Danger,
  };
  for (const option of request.options) {
    const style = STYLE_BY_OPTION[option] ?? ButtonStyle.Secondary;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`hitl:${option}:${request.correlationId}`)
        .setLabel(option.charAt(0).toUpperCase() + option.slice(1))
        .setStyle(style),
    );
  }
  return row;
}

// ── Register outbound handlers ────────────────────────────────────────────────

export function registerOutboundHandlers(ctx: DiscordContext): void {
  // ── Bus subscription: outbound messages ──────────────────────────────────
  ctx.bus.subscribe("message.outbound.discord.#", "discord-outbound", async (msg: BusMessage) => {
    const payload = msg.payload as Record<string, unknown>;
    const content = String(payload.content ?? "").slice(0, 2000);
    if (!content) return;
    const correlationId = msg.correlationId;

    const agentId = (payload.agentId as string | undefined)
      ?? (correlationId ? ctx.pendingAgents.get(correlationId) : undefined);
    const agentClient = agentId ? ctx.agentClients.get(agentId) : undefined;
    if (agentId && !agentClient) {
      console.debug(`[discord] No pool client for agent "${agentId}" — falling back to bus client`);
    }

    if (correlationId) {
      const pending = pendingReplies.get(correlationId);
      if (pending) {
        pendingReplies.delete(correlationId);
        ctx.pendingAgents.delete(correlationId);

        const pendingTurn = ctx.pendingTurns.get(correlationId);
        if (pendingTurn) {
          ctx.pendingTurns.delete(correlationId);
          ctx.conversationTracer.traceTurn({
            ...pendingTurn,
            output: content,
            endTime: new Date(),
          }).catch(err => console.error("[discord] Langfuse traceTurn error:", err));
        }

        if (pending.interaction) {
          await pending.interaction.editReply({ content }).catch(console.error);
          return;
        }

        if (pending.message) {
          const isDM = !pending.message.guild;

          if (isDM) {
            await (pending.message.channel as TextChannel).send({ content }).catch(console.error);
          } else if (agentClient) {
            const ch = agentClient.channels.cache.get(pending.message.channelId) as TextChannel | undefined;
            if (ch) {
              console.debug(`[discord] Routing reply via agent client "${agentId}"`);
              await ch.send({ content }).catch(console.error);
            } else {
              console.warn(`[discord] Agent "${agentId}" channel cache miss — falling back to bus client`);
              await pending.message.reply({ content }).catch(console.error);
            }
          } else {
            const reply = await pending.message.reply({ content }).catch(console.error);
            if (reply && !pending.message.channel.isThread()) {
              await reply.startThread({ name: content.slice(0, 50) || "Response" }).catch(() => {});
            }
          }

          if (!isDM) {
            await pending.message.reactions.resolve("👀")?.users.remove(ctx.client.user!).catch(() => {});
            await pending.message.react("✅").catch(() => {});
          }
          return;
        }
      }
    }

    // Unprompted push (cron, proactive notification)
    const channelId = String(
      payload.channel ?? payload.recipient
        ?? ctx.config.channels.digest
        ?? process.env.DISCORD_DIGEST_CHANNEL
        ?? ""
    );
    if (channelId) {
      const sendClient = agentClient ?? ctx.client;
      if (agentClient) {
        console.debug(`[discord] Routing push to channel ${channelId} via agent client "${agentId}"`);
      }
      const ch = sendClient.channels.cache.get(channelId) as TextChannel | undefined;
      await ch?.send({ content }).catch(console.error);
    }
  });

  // ── HITL renderer registration ────────────────────────────────────────────
  if (ctx.hitlPlugin) {
    ctx.hitlPlugin.registerRenderer("discord", {
      render: async (request, _busRef) => {
        const channelId = request.sourceMeta?.channelId;
        if (!channelId) {
          console.warn(`[discord] HITL ${request.correlationId} missing channelId — cannot render`);
          return;
        }
        const ch = ctx.client.channels.cache.get(channelId) as TextChannel | undefined;
        if (!ch) {
          console.warn(`[discord] HITL channel ${channelId} not in cache — cannot render`);
          return;
        }
        const embed = buildHITLEmbed(request);
        const row = buildHITLButtons(request);
        const msg = await ch.send({ embeds: [embed], components: [row] });
        ctx.pendingHITLMessages.set(request.correlationId, {
          message: msg,
          replyTopic: request.replyTopic,
        });
        console.log(`[discord] HITL ${request.correlationId} rendered in channel ${channelId}`);
      },
      onExpired: async (request, _busRef) => {
        const entry = ctx.pendingHITLMessages.get(request.correlationId);
        if (!entry) return;
        ctx.pendingHITLMessages.delete(request.correlationId);
        const expiredEmbed = new EmbedBuilder()
          .setTitle(request.title)
          .setDescription("**Approval expired** — re-trigger if still needed.")
          .setColor(0x6b7280);
        await entry.message.edit({ embeds: [expiredEmbed], components: [] }).catch(console.error);
        console.log(`[discord] HITL ${request.correlationId} marked expired`);
      },
    });
  }
}
