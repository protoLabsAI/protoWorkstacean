/**
 * discord/inbound.ts — DM and guild message handlers.
 *
 * Handles:
 *   MessageCreate  → @mention in guilds + DMs → message.inbound.discord.{channelId}
 *   MessageReactionAdd (📋) → bug triage → message.inbound.discord.{channelId}
 */

import {
  Events,
  type Client,
  type Message,
  type TextChannel,
} from "discord.js";
import type { EventBus } from "../../types.ts";
import type { ChannelRegistry } from "../../channels/channel-registry.ts";
import type { ConversationManager } from "../../conversation/conversation-manager.ts";
import type { ConversationTracer, TurnData } from "../../conversation/conversation-tracer.ts";
import type { RateLimiter } from "./rate-limit.ts";
import type { DiscordConfig, PendingReply } from "./core.ts";
import { isAdmin, makeId } from "./core.ts";

export type HandleDMFn = (
  message: Message,
  agentName: string | undefined,
  bus: EventBus,
) => Promise<void>;

export interface InboundContext {
  getConfig: () => DiscordConfig;
  rateLimiter: RateLimiter;
  conversationManager: ConversationManager;
  conversationTracer: ConversationTracer;
  pendingReplies: Map<string, PendingReply>;
  pendingAgents: Map<string, string>;
  pendingTurns: Map<string, TurnData>;
  channelRegistry?: ChannelRegistry;
}

/**
 * Handle an inbound DM — called from both the main bot and agent pool bots.
 *
 * DMs are always conversation-enabled (no channels.yaml entry needed).
 * The stable conversationId becomes the A2A contextId, giving the agent
 * full memory of the exchange across turns.
 *
 * agentName is undefined when the main bus bot receives the DM (routed by
 * A2A keyword matching). When an agent pool bot receives it, agentName is
 * the specific agent so the A2A layer routes directly.
 */
export async function handleDM(
  message: Message,
  agentName: string | undefined,
  bus: EventBus,
  ctx: InboundContext,
): Promise<void> {
  const userId = message.author.id;
  const { getConfig, rateLimiter, conversationManager, conversationTracer,
    pendingReplies, pendingAgents, pendingTurns } = ctx;

  if (!isAdmin(userId, getConfig().admins)) return;
  if (rateLimiter.isSpam(message.content)) { await message.delete().catch(() => {}); return; }
  if (rateLimiter.isRateLimited(userId)) {
    await (message.channel as TextChannel).send("Easy there — you're sending messages too quickly.").catch(() => {});
    return;
  }

  const timeoutMs = Number(process.env.DM_CONVERSATION_TIMEOUT_MS ?? 15 * 60_000);
  const conv = conversationManager.getOrCreate(message.channelId, userId, timeoutMs, agentName);
  const { conversationId, isNew, turnNumber } = conv;

  pendingReplies.set(conversationId, { message });
  if (agentName) pendingAgents.set(conversationId, agentName);

  const content = message.cleanContent.replace(/<@!?\d+>/g, "").trim();
  if (!content) return;

  // Langfuse tracing
  if (isNew) {
    conversationTracer.startTrace({
      conversationId,
      userId,
      channelId: message.channelId,
      agentName,
      platform: "discord-dm",
    }).catch(err => console.error("[discord] Langfuse startTrace error:", err));
  }
  pendingTurns.set(conversationId, {
    conversationId,
    turnNumber,
    input: content,
    userId,
    agentName,
    startTime: new Date(),
  });

  bus.publish(`message.inbound.discord.${message.channelId}`, {
    id: message.id,
    correlationId: conversationId,
    topic: `message.inbound.discord.${message.channelId}`,
    timestamp: Date.now(),
    payload: {
      sender: userId,
      channel: message.channelId,
      content,
      isDM: true,
      ...(agentName ? { agentId: agentName } : {}),
    },
    source: { interface: "discord" as const, channelId: message.channelId, userId },
    reply: { topic: `message.outbound.discord.${message.channelId}` },
  });
}

/**
 * Register MessageCreate and MessageReactionAdd handlers on the main client.
 */
export function setupInboundHandlers(
  client: Client,
  bus: EventBus,
  ctx: InboundContext,
  dmHandler: HandleDMFn,
): void {
  const { getConfig, rateLimiter, conversationManager, conversationTracer,
    pendingReplies, pendingAgents, pendingTurns, channelRegistry } = ctx;

  // ── Message create ─────────────────────────────────────────────────────────
  client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;

    // DMs — auto conversation, no @mention needed, main bot has no assigned agent
    if (!message.guild) {
      await dmHandler(message, undefined, bus);
      return;
    }

    const isMentioned = message.mentions.has(client.user!);
    const userId = message.author.id;

    // Look up channel config early — needed for conversation settings check
    const channelEntry = channelRegistry?.findByTopic(`message.inbound.discord.${message.channelId}`);
    const convConfig = channelEntry?.conversation;
    const convEnabled = convConfig?.enabled === true;

    // Allow continuing an active conversation without an @mention
    const continueWithoutMention =
      convEnabled &&
      convConfig?.requireMentionAfterFirst !== true &&
      conversationManager.has(message.channelId, userId);

    if (!isMentioned && !continueWithoutMention) return;

    const config = getConfig();
    if (!isAdmin(userId, config.admins)) {
      console.log(`[discord] message from ${userId} ignored — not in admins list`);
      return;
    }

    if (rateLimiter.isSpam(message.content)) {
      await message.delete().catch(() => {});
      return;
    }
    if (rateLimiter.isRateLimited(userId)) {
      await message.reply("Easy there — you're sending messages too quickly.").catch(() => {});
      return;
    }

    await message.react("👀").catch(() => {});

    // Determine correlationId — stable across turns when conversation is enabled
    let correlationId: string;
    let isNewConversation = false;
    let turnNumber = 1;

    if (convEnabled) {
      const conv = conversationManager.getOrCreate(
        message.channelId,
        userId,
        convConfig?.timeoutMs ?? 5 * 60_000,
        channelEntry?.agent,
      );
      correlationId = conv.conversationId;
      isNewConversation = conv.isNew;
      turnNumber = conv.turnNumber;
    } else {
      correlationId = makeId();
    }

    pendingReplies.set(correlationId, { message });

    if (channelEntry?.agent) {
      pendingAgents.set(correlationId, channelEntry.agent);
    }

    const content = message.cleanContent
      .replace(/<@!?\d+>/g, "")
      .trim();

    // Langfuse conversation tracing
    if (convEnabled) {
      if (isNewConversation) {
        conversationTracer.startTrace({
          conversationId: correlationId,
          userId,
          channelId: message.channelId,
          agentName: channelEntry?.agent,
          platform: "discord",
        }).catch(err => console.error("[discord] Langfuse startTrace error:", err));
      }
      // Store turn data — log raw content, not the memory-prefixed version
      pendingTurns.set(correlationId, {
        conversationId: correlationId,
        turnNumber,
        input: content,
        userId,
        agentName: channelEntry?.agent,
        startTime: new Date(),
      });
    }

    bus.publish(`message.inbound.discord.${message.channelId}`, {
      id: message.id,
      correlationId,
      topic: `message.inbound.discord.${message.channelId}`,
      timestamp: Date.now(),
      payload: {
        sender: userId,
        channel: message.channelId,
        content,
        isThread: message.channel.isThread(),
        guildId: message.guildId,
        ...(channelEntry?.agent ? { agentId: channelEntry.agent } : {}),
      },
      source: { interface: "discord" as const, channelId: message.channelId, userId },
      reply: { topic: `message.outbound.discord.${message.channelId}` },
    });
  });

  // ── 📋 reaction → bug triage ───────────────────────────────────────────────
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot) return;
    if (reaction.emoji.name !== "📋") return;
    if (!isAdmin(user.id, getConfig().admins)) {
      console.log(`[discord] reaction from ${user.id} ignored — not in admins list`);
      return;
    }

    const message = reaction.partial
      ? await reaction.message.fetch()
      : reaction.message as Message;

    await message.react("👀").catch(() => {});

    const correlationId = makeId();
    pendingReplies.set(correlationId, { message });

    bus.publish(`message.inbound.discord.${message.channelId}`, {
      id: `${message.id}-clip`,
      correlationId,
      topic: `message.inbound.discord.${message.channelId}`,
      timestamp: Date.now(),
      payload: {
        sender: user.id,
        channel: message.channelId,
        content: message.content,
        skillHint: "bug_triage",
        isReaction: true,
      },
      source: { interface: "discord" as const, channelId: message.channelId, userId: user.id },
      reply: { topic: `message.outbound.discord.${message.channelId}` },
    });
  });
}
