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
import { logger } from "../../log.ts";

const log = logger("discord");

export function registerLifecycleHandlers(client: Client, label = "main"): void {
  client.on(Events.Error, (err) => {
    log.error("client error", { label, err: err instanceof Error ? err.message : err });
  });
  client.on(Events.Warn, (msg) => {
    log.warn(`warn: ${msg}`, { label });
  });
  client.on(Events.ShardError, (err, shardId) => {
    log.error("shard error", { label, shardId, err: err instanceof Error ? err.message : err });
  });
  client.on(Events.ShardDisconnect, (event, shardId) => {
    log.warn(
      `shard ${shardId} disconnected (code ${event?.code ?? "?"}) — auto-reconnecting`,
      { label },
    );
  });
  client.on(Events.ShardReconnecting, (shardId) => {
    log.info(`shard ${shardId} reconnecting…`, { label });
  });
  client.on(Events.ShardResume, (shardId, replayed) => {
    log.info(`shard ${shardId} resumed (${replayed} event(s) replayed)`, { label });
  });
}
