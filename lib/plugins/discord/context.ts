/**
 * context.ts — assemble surrounding Discord context for an inbound message.
 *
 * Ava used to receive only the bare text of the message that triggered her, so
 * she couldn't see what a reply was replying to, the recent channel scrollback,
 * the thread she's in, or any attachments. This builds a compact context
 * preamble from those signals and ships it alongside the message (as
 * `contextPreamble` on the bus payload) so the executor can inject it into the
 * turn without polluting the stored conversation history.
 *
 * Everything here is best-effort and defensive — a failed fetch degrades to
 * less context, never an error.
 */

import { type Message, type TextChannel, ChannelType } from "discord.js";

/** How many prior channel messages to include as scrollback. */
const SCROLLBACK_LIMIT = 6;
/** Per-message content cap inside the preamble (keep it bounded). */
const SNIPPET_CHARS = 280;

function snippet(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > SNIPPET_CHARS ? clean.slice(0, SNIPPET_CHARS) + "…" : clean;
}

function authorName(m: Message): string {
  return m.member?.displayName ?? m.author?.globalName ?? m.author?.username ?? "someone";
}

/**
 * Build a context preamble for `message`. Returns "" when there's nothing
 * useful to add (keeps the LLM input clean for plain messages).
 */
export async function buildMessageContext(message: Message): Promise<string> {
  const parts: string[] = [];

  // 1. Replied-to message — the most direct context signal.
  if (message.reference?.messageId) {
    try {
      const ref = await message.fetchReference();
      const refText = snippet(ref.cleanContent || "(no text)");
      parts.push(`The user is replying to ${authorName(ref)}: "${refText}"`);
    } catch {
      /* reference gone / uncached — skip */
    }
  }

  // 2. Thread context — name + starter message if we're inside one.
  const channel = message.channel;
  if (channel.isThread()) {
    try {
      const starter = await channel.fetchStarterMessage().catch(() => null);
      const threadName = channel.name ? `Thread "${channel.name}"` : "This thread";
      parts.push(
        starter
          ? `${threadName}, started by ${authorName(starter)}: "${snippet(starter.cleanContent || "(no text)")}"`
          : `${threadName}.`,
      );
    } catch {
      /* skip */
    }
  }

  // 3. Recent channel scrollback (excluding this message), oldest-first.
  if ("messages" in channel) {
    try {
      const recent = await (channel as TextChannel).messages.fetch({
        limit: SCROLLBACK_LIMIT,
        before: message.id,
      });
      const lines = [...recent.values()]
        .reverse()
        .filter((m) => (m.cleanContent || m.attachments.size > 0))
        .map((m) => `  ${authorName(m)}: ${snippet(m.cleanContent || "(attachment)")}`);
      if (lines.length > 0) {
        parts.push(`Recent messages in this channel:\n${lines.join("\n")}`);
      }
    } catch {
      /* skip */
    }
  }

  // 4. Attachments / embeds on the triggering message.
  if (message.attachments.size > 0) {
    const names = [...message.attachments.values()].map((a) => a.name ?? a.url).slice(0, 5);
    parts.push(`Attachments on this message: ${names.join(", ")}`);
  }

  if (parts.length === 0) return "";
  return `[Conversation context]\n${parts.join("\n")}`;
}

/** Whether this channel type can supply scrollback (text/thread/announcement). */
export function channelSupportsContext(message: Message): boolean {
  const t = message.channel.type;
  return (
    t === ChannelType.GuildText ||
    t === ChannelType.PublicThread ||
    t === ChannelType.PrivateThread ||
    t === ChannelType.GuildAnnouncement ||
    t === ChannelType.DM
  );
}
