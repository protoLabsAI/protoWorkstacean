/**
 * dm-warming.ts — Pre-warm DM channels so Discord delivers gateway events.
 *
 * Discord's gateway only sends MESSAGE_CREATE for DM channels in the session's
 * private_channels list (sent in READY). Calling createDM() subscribes the bot
 * to that channel for this session.
 */

import type { Client } from "discord.js";
import type { DiscordContext } from "./core.ts";

export async function warmDmChannels(ctx: DiscordContext, client: Client<true>): Promise<void> {
  const discordIds = ctx.identityRegistry
    ?.memoryEnabledUsers()
    .map(u => u.identities.discord)
    .filter((id): id is string => !!id)
    ?? [];
  if (!discordIds.length) return;
  let warmed = 0;
  for (const discordId of discordIds) {
    try {
      await client.users.createDM(discordId);
      warmed++;
    } catch { /* skip if user not reachable */ }
  }
  if (warmed) console.log(`[discord] Pre-warmed ${warmed} DM channel(s)`);
}
