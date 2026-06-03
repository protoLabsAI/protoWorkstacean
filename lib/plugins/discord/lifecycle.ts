/**
 * lifecycle.ts — connection-lifecycle visibility for the Discord client.
 *
 * discord.js handles reconnection internally, but silently — a flaky gateway
 * connection was previously invisible until messages simply stopped arriving.
 * These handlers log shard disconnect / reconnecting / resume / error + client
 * error/warn so a degraded connection is observable (and greppable by the
 * existing alert.discord_disconnected monitor).
 */

import { Events, type Client } from "discord.js";

export function registerLifecycleHandlers(client: Client, label = "main"): void {
  client.on(Events.Error, (err) => {
    console.error(`[discord:${label}] client error:`, err instanceof Error ? err.message : err);
  });
  client.on(Events.Warn, (msg) => {
    console.warn(`[discord:${label}] warn: ${msg}`);
  });
  client.on(Events.ShardError, (err, shardId) => {
    console.error(`[discord:${label}] shard ${shardId} error:`, err instanceof Error ? err.message : err);
  });
  client.on(Events.ShardDisconnect, (event, shardId) => {
    console.warn(
      `[discord:${label}] shard ${shardId} disconnected (code ${event?.code ?? "?"}) — auto-reconnecting`,
    );
  });
  client.on(Events.ShardReconnecting, (shardId) => {
    console.log(`[discord:${label}] shard ${shardId} reconnecting…`);
  });
  client.on(Events.ShardResume, (shardId, replayed) => {
    console.log(`[discord:${label}] shard ${shardId} resumed (${replayed} event(s) replayed)`);
  });
}
