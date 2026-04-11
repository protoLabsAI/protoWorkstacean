/**
 * discord/dm-warming.ts — DM channel pre-warming logic.
 *
 * Discord only delivers MESSAGE_CREATE gateway events for DM channels that
 * appear in the session's private_channels list (sent in READY). Calling
 * createDM() subscribes the bot to that channel for the current session.
 */

import type { Client } from "discord.js";
import type { IdentityRegistry } from "../../identity/identity-registry.ts";

/**
 * Pre-warm DM channels for all users in the identity registry that have a
 * Discord ID set.
 */
export async function warmDmChannels(
  client: Client<true>,
  identityRegistry: IdentityRegistry | null,
): Promise<void> {
  const discordIds = identityRegistry
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
