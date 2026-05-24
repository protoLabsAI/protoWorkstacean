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
import type { BusMessage } from "../../types.ts";
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

}
