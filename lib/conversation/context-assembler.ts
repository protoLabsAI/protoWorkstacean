import type { ConversationTurn } from "../types.ts";

/**
 * Assemble a structured context envelope for the agent prompt.
 *
 * Pure function — no side effects, suitable for unit testing.
 *
 * Sections emitted (in order, only when non-empty):
 *   <recalled_memory>  — Graphiti facts retrieved for this user
 *   <recent_conversation> — last N turns from LoggerPlugin
 *   <current_message>  — the user's actual input (always emitted)
 *
 * When there is no history (no memory, no turns), only <current_message>
 * is emitted — no empty XML tags.
 */
export function assembleContext(
  recalledMemory: string | undefined,
  recentTurns: ConversationTurn[],
  currentMessage: string,
): string {
  const parts: string[] = [];

  if (recalledMemory) {
    parts.push(
      `<recalled_memory>\n` +
      `The following facts were retrieved from your memory about this user. ` +
      `Use them as background context if relevant — do NOT repeat them back ` +
      `to the user or reference them unless the user's message specifically ` +
      `asks about something they relate to. Focus your response on what the ` +
      `user is actually saying below.\n\n` +
      `${recalledMemory}\n` +
      `</recalled_memory>`,
    );
  }

  if (recentTurns.length > 0) {
    const turnLines = recentTurns.map(turn => {
      const ts = new Date(turn.timestamp).toISOString();
      const channelSuffix = turn.channelId ? ` [${turn.channelId}]` : "";
      const label = turn.role === "user" ? "User" : "Assistant";
      return `[${ts}${channelSuffix}] ${label}: ${turn.text}`;
    });
    parts.push(`<recent_conversation>\n${turnLines.join("\n")}\n</recent_conversation>`);
  }

  parts.push(`<current_message>\n${currentMessage}\n</current_message>`);

  return parts.join("\n\n");
}
