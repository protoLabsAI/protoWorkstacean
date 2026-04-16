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
import type { BusMessage, HITLRequest, ConfigChangeRequest } from "../../types.ts";
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

// ── Config-change embed/button builders (Arc 9.3) ─────────────────────────────
// Purple colour signals "the rules of the system are changing" vs the amber
// "one-shot operational approval" colour used for regular HITL. Renders up to
// three embeds: main info, YAML diff, GOAP/coverage impact analysis.

export function buildConfigChangeEmbeds(request: ConfigChangeRequest): EmbedBuilder[] {
  const embeds: EmbedBuilder[] = [];
  const COLOR = 0x8b5cf6; // purple

  const main = new EmbedBuilder()
    .setTitle(`⚙️ Config Change — ${request.configFile}`)
    .setDescription(`**${request.title}**\n\n${request.summary.slice(0, 3800)}`)
    .setColor(COLOR)
    .setFooter({
      text: `config.change gate  •  Expires ${new Date(request.expiresAt).toLocaleString()}`,
    });
  embeds.push(main);

  if (request.yamlDiff) {
    // Discord code-block limit is 2000 chars per field; truncate gracefully.
    const diff = request.yamlDiff.slice(0, 1900);
    embeds.push(
      new EmbedBuilder()
        .setTitle("Proposed diff")
        .setDescription(`\`\`\`diff\n${diff}\n\`\`\``)
        .setColor(COLOR),
    );
  }

  const impactLines: string[] = [];
  if (request.goapImpact) {
    impactLines.push(`**GOAP dry-run:** ${request.goapImpact.summary}`);
    const imp = request.goapImpact;
    if (imp.addedGoals?.length)     impactLines.push(`+ Goals added: ${imp.addedGoals.join(", ")}`);
    if (imp.removedGoals?.length)   impactLines.push(`- Goals removed: ${imp.removedGoals.join(", ")}`);
    if (imp.modifiedGoals?.length)  impactLines.push(`~ Goals modified: ${imp.modifiedGoals.join(", ")}`);
    if (imp.addedActions?.length)   impactLines.push(`+ Actions added: ${imp.addedActions.join(", ")}`);
    if (imp.removedActions?.length) impactLines.push(`- Actions removed: ${imp.removedActions.join(", ")}`);
    if (imp.modifiedActions?.length)impactLines.push(`~ Actions modified: ${imp.modifiedActions.join(", ")}`);
  }
  if (request.coverageImpact) {
    impactLines.push(`**Coverage:** ${request.coverageImpact.summary}`);
    if (request.coverageImpact.affectedTestFiles.length) {
      impactLines.push(`Affected test files: ${request.coverageImpact.affectedTestFiles.join(", ")}`);
    }
  }
  if (impactLines.length) {
    embeds.push(
      new EmbedBuilder()
        .setTitle("Impact analysis")
        .setDescription(impactLines.join("\n").slice(0, 4096))
        .setColor(COLOR),
    );
  }

  return embeds;
}

export function buildConfigChangeButtons(request: ConfigChangeRequest): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  const STYLE_BY_OPTION: Record<string, ButtonStyle> = {
    approve: ButtonStyle.Success,
    reject: ButtonStyle.Danger,
  };
  for (const option of request.options) {
    const style = STYLE_BY_OPTION[option] ?? ButtonStyle.Secondary;
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`config_change:${option}:${request.correlationId}`)
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

  // ── DM-by-user-id: resolve a user ID to their DM channel on demand ───────
  // Subscribers publish to `message.outbound.discord.dm.user.{userId}` when
  // they want to DM a user without knowing the channel ID. The agent bot
  // (stamped via payload.agentId) opens the DM via users.fetch().createDM()
  // so the message comes from the correct bot identity.
  ctx.bus.subscribe("message.outbound.discord.dm.user.#", "discord-dm-user", async (msg: BusMessage) => {
    const payload = msg.payload as Record<string, unknown>;
    const content = String(payload.content ?? "").slice(0, 2000);
    if (!content) return;

    // Extract user ID from topic: message.outbound.discord.dm.user.{userId}
    const parts = msg.topic.split(".");
    const userId = parts[parts.length - 1];
    if (!userId || !/^\d+$/.test(userId)) {
      console.warn(`[discord] Invalid user ID on DM topic ${msg.topic}`);
      return;
    }

    const agentId = payload.agentId as string | undefined;
    const agentClient = agentId ? ctx.agentClients.get(agentId) : undefined;
    const client = agentClient ?? ctx.client;

    try {
      const user = await client.users.fetch(userId);
      const dm = await user.createDM();
      await dm.send({ content });
      console.log(`[discord] DM delivered to user ${userId} via ${agentId ?? "default"} bot`);
    } catch (err) {
      console.error(`[discord] DM to user ${userId} failed:`, err);
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

  // ── Config-change renderer registration (Arc 9.3) ────────────────────────
  if (ctx.configChangePlugin) {
    ctx.configChangePlugin.registerRenderer("discord", {
      render: async (request, _busRef) => {
        const channelId = request.sourceMeta?.channelId;
        if (!channelId) {
          console.warn(`[discord] config_change ${request.correlationId} missing channelId — cannot render`);
          return;
        }
        const ch = ctx.client.channels.cache.get(channelId) as TextChannel | undefined;
        if (!ch) {
          console.warn(`[discord] config_change channel ${channelId} not in cache — cannot render`);
          return;
        }
        const embeds = buildConfigChangeEmbeds(request);
        const row = buildConfigChangeButtons(request);
        const msg = await ch.send({ embeds, components: [row] });
        ctx.pendingConfigChangeMessages.set(request.correlationId, {
          message: msg,
          replyTopic: request.replyTopic,
        });
        console.log(`[discord] config_change ${request.correlationId} rendered in channel ${channelId}`);
      },
      onExpired: async (request, _busRef) => {
        const entry = ctx.pendingConfigChangeMessages.get(request.correlationId);
        if (!entry) return;
        ctx.pendingConfigChangeMessages.delete(request.correlationId);
        const expiredEmbed = new EmbedBuilder()
          .setTitle(request.title)
          .setDescription("**Config change approval expired** — re-trigger if still needed.")
          .setColor(0x6b7280);
        await entry.message.edit({ embeds: [expiredEmbed], components: [] }).catch(console.error);
        console.log(`[discord] config_change ${request.correlationId} marked expired`);
      },
    });
  }
}
