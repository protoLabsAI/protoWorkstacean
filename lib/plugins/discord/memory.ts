/**
 * memory.ts — /memory slash command implementation.
 *
 * Handles show, search, and clear subcommands against the Graphiti memory store.
 */

import type { ChatInputCommandInteraction } from "discord.js";
import type { DiscordContext } from "./core.ts";

export async function handleMemoryCommand(
  ctx: DiscordContext,
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const userId = interaction.user.id;

  if (!ctx.identityRegistry) {
    await interaction.editReply("Memory not available.").catch(console.error);
    return;
  }

  const groupId = ctx.identityRegistry.groupId("discord", userId);
  const subName = interaction.options.getSubcommand(false);

  if (!subName || subName === "show") {
    const facts = await ctx.graphiti.search(groupId, "preferences habits goals context", 20).catch(() => []);
    if (facts.length === 0) {
      await interaction.editReply("No memory stored yet.").catch(console.error);
      return;
    }
    const now = Date.now();
    const active = facts.filter(f => {
      if (f.invalid_at && new Date(f.invalid_at).getTime() <= now) return false;
      if (f.expired_at && new Date(f.expired_at).getTime() <= now) return false;
      return true;
    });
    if (active.length === 0) {
      await interaction.editReply("No active memory facts.").catch(console.error);
      return;
    }
    const lines = active.map((f, i) => `**${i + 1}.** ${f.fact}`).join("\n");
    await interaction.editReply(`**Memory** (${active.length} facts):\n${lines}`.slice(0, 2000)).catch(console.error);

  } else if (subName === "search") {
    const query = interaction.options.getString("query", true);
    const facts = await ctx.graphiti.search(groupId, query, 10).catch(() => []);
    if (facts.length === 0) {
      await interaction.editReply(`No facts found for: "${query}"`).catch(console.error);
      return;
    }
    const lines = facts.map((f, i) => `**${i + 1}.** ${f.fact}`).join("\n");
    await interaction.editReply(`**"${query}"** — ${facts.length} fact(s):\n${lines}`.slice(0, 2000)).catch(console.error);

  } else if (subName === "clear") {
    await ctx.graphiti.clearUser(groupId);
    await interaction.editReply("Memory cleared.").catch(console.error);
  }
}
