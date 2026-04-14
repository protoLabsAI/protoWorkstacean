/**
 * inbound.ts — DM and guild message handlers.
 *
 * Registers MessageCreate and MessageReactionAdd event listeners on the main
 * Discord client, and handles DM batching via DmAccumulator.
 */

import { Events, type Message, type TextChannel } from "discord.js";
import { DmAccumulator, type AccumulatorEntry } from "../../dm/dm-accumulator.ts";
import { makeId, type DiscordContext } from "./core.ts";
import { isRateLimited, isSpam } from "./rate-limit.ts";
import { pendingReplies } from "./outbound.ts";

// ── Admin check ───────────────────────────────────────────────────────────────

function isAdmin(ctx: DiscordContext, userId: string): boolean {
  if (!ctx.config.admins?.length) return true;
  return ctx.config.admins.includes(userId);
}

// ── DM handler ────────────────────────────────────────────────────────────────

export async function handleDM(
  ctx: DiscordContext,
  message: Message,
  agentName: string | undefined,
): Promise<void> {
  const userId = message.author.id;

  if (!isAdmin(ctx, userId)) return;
  if (isSpam(ctx, message.content)) { await message.delete().catch(() => {}); return; }
  if (isRateLimited(ctx, userId)) {
    await (message.channel as TextChannel).send("Easy there — you're sending messages too quickly.").catch(() => {});
    return;
  }

  const timeoutMs = Number(process.env.DM_CONVERSATION_TIMEOUT_MS ?? 15 * 60_000);
  const conv = ctx.conversationManager.getOrCreate(message.channelId, userId, timeoutMs, agentName);
  const { conversationId, isNew, turnNumber } = conv;

  const content = message.cleanContent.replace(/<@!?\d+>/g, "").trim();
  if (!content) return;

  ctx.dmAccumulator!.push({
    conversationId,
    userId,
    channelId: message.channelId,
    agentName,
    message: { id: message.id, channelId: message.channelId },
    content,
    turnNumber,
    isNew,
  });
}

// ── DM flush callback ─────────────────────────────────────────────────────────

export async function handleDMFlush(
  ctx: DiscordContext,
  entry: Omit<AccumulatorEntry, "timer">,
): Promise<void> {
  const {
    conversationId, userId, channelId, agentName,
    lastMessage, contents, turnNumber, isNew,
  } = entry;

  const batchedContent = contents.length === 1
    ? contents[0]
    : contents.map((c, i) => `[${i + 1}/${contents.length}] ${c}`).join("\n\n");

  if (ctx.isExecutionActive?.(conversationId) && ctx.mailbox) {
    console.log(
      `[discord] Agent in-flight for ${conversationId} — queuing ${contents.length} message(s) to mailbox`,
    );
    ctx.mailbox.push(conversationId, {
      content: batchedContent,
      sender: userId,
      receivedAt: Date.now(),
    });
    return;
  }

  const client = (agentName ? ctx.agentClients.get(agentName) : undefined) ?? ctx.client;
  const discordChannel = client?.channels.cache.get(channelId);
  const discordMessage = discordChannel && "messages" in discordChannel
    ? await (discordChannel as TextChannel).messages.fetch(lastMessage.id).catch(() => null)
    : null;

  if (discordMessage) {
    pendingReplies.set(conversationId, { message: discordMessage });
  } else {
    console.warn(`[discord] Could not fetch message for ${conversationId} via ${agentName ?? "main"} — reply will use unprompted push`);
  }
  if (agentName) ctx.pendingAgents.set(conversationId, agentName);

  if (isNew) {
    ctx.conversationTracer.startTrace({
      conversationId,
      userId,
      channelId,
      agentName,
      platform: "discord-dm",
    }).catch(err => console.error("[discord] Langfuse startTrace error:", err));
  }
  ctx.pendingTurns.set(conversationId, {
    conversationId,
    turnNumber,
    input: batchedContent,
    userId,
    agentName,
    startTime: new Date(),
  });

  if (agentName) {
    ctx.bus.publish("agent.skill.request", {
      id: lastMessage.id,
      correlationId: conversationId,
      topic: "agent.skill.request",
      timestamp: Date.now(),
      payload: {
        skill: "chat",
        content: batchedContent,
        targets: [agentName],
        isDM: true,
      },
      source: { interface: "discord" as const, channelId, userId },
      reply: { topic: `message.outbound.discord.${channelId}` },
    });
  } else {
    ctx.bus.publish(`message.inbound.discord.${channelId}`, {
      id: lastMessage.id,
      correlationId: conversationId,
      topic: `message.inbound.discord.${channelId}`,
      timestamp: Date.now(),
      payload: {
        sender: userId,
        channel: channelId,
        content: batchedContent,
        isDM: true,
      },
      source: { interface: "discord" as const, channelId, userId },
      reply: { topic: `message.outbound.discord.${channelId}` },
    });
  }
}

// ── Setup DmAccumulator ───────────────────────────────────────────────────────

export function setupDmAccumulator(ctx: DiscordContext): void {
  ctx.dmAccumulator = new DmAccumulator({
    debounceMs: Number(process.env.DM_DEBOUNCE_MS ?? 3000),
    onFlush: (entry) => handleDMFlush(ctx, entry),
    fallbackMailbox: ctx.mailbox,
  });
}

// ── Register inbound event handlers ──────────────────────────────────────────

export function registerInboundHandlers(ctx: DiscordContext): void {
  // ── DM and guild message handling ────────────────────────────────────────
  ctx.client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;

    if (!message.guild) {
      await handleDM(ctx, message, undefined);
      return;
    }

    const isMentioned = message.mentions.has(ctx.client.user!);
    const userId = message.author.id;

    const channelEntry = ctx.channelRegistry?.findByTopic(`message.inbound.discord.${message.channelId}`);
    const convConfig = channelEntry?.conversation;
    const convEnabled = convConfig?.enabled === true;

    const continueWithoutMention =
      convEnabled &&
      convConfig?.requireMentionAfterFirst !== true &&
      ctx.conversationManager.has(message.channelId, userId);

    if (!isMentioned && !continueWithoutMention) return;

    if (!isAdmin(ctx, userId)) {
      console.log(`[discord] message from ${userId} ignored — not in admins list`);
      return;
    }

    if (isSpam(ctx, message.content)) {
      await message.delete().catch(() => {});
      return;
    }
    if (isRateLimited(ctx, userId)) {
      await message.reply("Easy there — you're sending messages too quickly.").catch(() => {});
      return;
    }

    await message.react("👀").catch(() => {});

    let correlationId: string;
    let isNewConversation = false;
    let turnNumber = 1;

    if (convEnabled) {
      const conv = ctx.conversationManager.getOrCreate(
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
      ctx.pendingAgents.set(correlationId, channelEntry.agent);
    }

    const content = message.cleanContent
      .replace(/<@!?\d+>/g, "")
      .trim();

    if (convEnabled) {
      if (isNewConversation) {
        ctx.conversationTracer.startTrace({
          conversationId: correlationId,
          userId,
          channelId: message.channelId,
          agentName: channelEntry?.agent,
          platform: "discord",
        }).catch(err => console.error("[discord] Langfuse startTrace error:", err));
      }
      ctx.pendingTurns.set(correlationId, {
        conversationId: correlationId,
        turnNumber,
        input: content,
        userId,
        agentName: channelEntry?.agent,
        startTime: new Date(),
      });
    }

    ctx.bus.publish(`message.inbound.discord.${message.channelId}`, {
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

  // ── 📋 reaction → bug triage ─────────────────────────────────────────────
  ctx.client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot) return;
    if (reaction.emoji.name !== "📋") return;
    if (!isAdmin(ctx, user.id)) {
      console.log(`[discord] reaction from ${user.id} ignored — not in admins list`);
      return;
    }

    const message = reaction.partial
      ? await reaction.message.fetch()
      : reaction.message as Message;

    await message.react("👀").catch(() => {});

    const correlationId = makeId();
    pendingReplies.set(correlationId, { message });

    ctx.bus.publish(`message.inbound.discord.${message.channelId}`, {
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
