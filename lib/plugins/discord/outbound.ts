/**
 * discord/outbound.ts — reply handling, HITL rendering, and outbound routing.
 *
 * Handles:
 *   message.outbound.discord.#  → reply to pending messages / interactions
 *   message.outbound.discord.push.{channelId} → unprompted post (cron, etc.)
 *
 * Also registers the HITL Discord renderer with the HITL plugin.
 */

import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type TextChannel,
  type Message,
} from "discord.js";
import type { EventBus, BusMessage, HITLRequest } from "../../types.ts";
import type { HITLPlugin } from "../hitl.ts";
import type { ConversationTracer, TurnData } from "../../conversation/conversation-tracer.ts";
import type { AgentPool } from "./agent-pool.ts";
import type { HitlEntry } from "./slash-commands.ts";
import type { DiscordConfig, PendingReply } from "./core.ts";

export interface OutboundContext {
  client: Client;
  agentPool: AgentPool;
  pendingReplies: Map<string, PendingReply>;
  pendingAgents: Map<string, string>;
  pendingTurns: Map<string, TurnData>;
  conversationTracer: ConversationTracer;
  getConfig: () => DiscordConfig;
}

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

/**
 * Subscribe to outbound discord messages on the bus and route them to the
 * appropriate Discord channel / interaction reply.
 */
export function setupOutboundSubscription(bus: EventBus, ctx: OutboundContext): void {
  const { client, agentPool, pendingReplies, pendingAgents, pendingTurns,
    conversationTracer, getConfig } = ctx;

  bus.subscribe("message.outbound.discord.#", "discord-outbound", async (msg: BusMessage) => {
    const payload = msg.payload as Record<string, unknown>;
    const content = String(payload.content ?? "").slice(0, 2000);
    if (!content) return; // drop empty outbound messages silently
    const correlationId = msg.correlationId;

    // Resolve agent-specific client — payload.agentId wins, then pendingAgents map
    const agentId = (payload.agentId as string | undefined)
      ?? (correlationId ? pendingAgents.get(correlationId) : undefined);
    const agentClient = agentId ? agentPool.getClient(agentId) : undefined;
    if (agentId && !agentClient) {
      console.debug(`[discord] No pool client for agent "${agentId}" — falling back to bus client`);
    }

    // 1. Pending reply from a prior inbound message
    if (correlationId) {
      const pending = pendingReplies.get(correlationId);
      if (pending) {
        pendingReplies.delete(correlationId);
        pendingAgents.delete(correlationId);

        // Finalize Langfuse generation
        const pendingTurn = pendingTurns.get(correlationId);
        if (pendingTurn) {
          pendingTurns.delete(correlationId);
          conversationTracer.traceTurn({
            ...pendingTurn,
            output: content,
            endTime: new Date(),
          }).catch(err => console.error("[discord] Langfuse traceTurn error:", err));

          // Note: Graphiti addEpisode is handled by SkillDispatcherPlugin for all channels.
        }

        if (pending.interaction) {
          // Slash command interactions always use the bus client
          await pending.interaction.editReply({ content }).catch(console.error);
          return;
        }

        if (pending.message) {
          const isDM = !pending.message.guild;

          if (isDM) {
            // DMs: reply directly through the message's own channel (works for any bot client)
            await (pending.message.channel as TextChannel).send({ content }).catch(console.error);
          } else if (agentClient) {
            // Guild message via agent's bot identity
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
            // Start a thread on first guild response if not already in one
            if (reply && !pending.message.channel.isThread()) {
              await reply.startThread({ name: content.slice(0, 50) || "Response" }).catch(() => {});
            }
          }

          // Reactions: only in guild channels (the main client owns them there)
          if (!isDM) {
            await pending.message.reactions.resolve("👀")?.users.remove(client.user!).catch(() => {});
            await pending.message.react("✅").catch(() => {});
          }
          return;
        }
      }
    }

    // 2. Unprompted push (cron, proactive notification)
    const channelId = String(
      payload.channel ?? payload.recipient
        ?? getConfig().channels.digest
        ?? process.env.DISCORD_DIGEST_CHANNEL
        ?? ""
    );
    if (channelId) {
      const sendClient = agentClient ?? client;
      if (agentClient) {
        console.debug(`[discord] Routing push to channel ${channelId} via agent client "${agentId}"`);
      }
      const ch = sendClient.channels.cache.get(channelId) as TextChannel | undefined;
      await ch?.send({ content }).catch(console.error);
    }
  });
}

/**
 * Register the Discord HITL renderer with the HITL plugin.
 */
export function setupHITLRenderer(
  hitlPlugin: HITLPlugin | undefined,
  client: Client,
  bus: EventBus,
  pendingHITLMessages: Map<string, HitlEntry>,
): void {
  if (!hitlPlugin) return;

  hitlPlugin.registerRenderer("discord", {
    render: async (request, _busRef) => {
      const channelId = request.sourceMeta?.channelId;
      if (!channelId) {
        console.warn(`[discord] HITL ${request.correlationId} missing channelId — cannot render`);
        return;
      }
      const ch = client.channels.cache.get(channelId) as TextChannel | undefined;
      if (!ch) {
        console.warn(`[discord] HITL channel ${channelId} not in cache — cannot render`);
        return;
      }
      const embed = buildHITLEmbed(request);
      const row = buildHITLButtons(request);
      const msg = await ch.send({ embeds: [embed], components: [row] });
      pendingHITLMessages.set(request.correlationId, {
        message: msg,
        replyTopic: request.replyTopic,
      });
      console.log(`[discord] HITL ${request.correlationId} rendered in channel ${channelId}`);
    },
    onExpired: async (request, _busRef) => {
      const entry = pendingHITLMessages.get(request.correlationId);
      if (!entry) return;
      pendingHITLMessages.delete(request.correlationId);
      const expiredEmbed = new EmbedBuilder()
        .setTitle(request.title)
        .setDescription("**Approval expired** — re-trigger if still needed.")
        .setColor(0x6b7280);
      await entry.message.edit({ embeds: [expiredEmbed], components: [] }).catch(console.error);
      console.log(`[discord] HITL ${request.correlationId} marked expired`);
    },
  });
}
