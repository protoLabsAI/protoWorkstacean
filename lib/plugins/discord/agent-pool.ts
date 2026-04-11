/**
 * discord/agent-pool.ts — multi-bot client pool (DISCORD_BOT_TOKEN_* env vars).
 *
 * Each agent can have a dedicated Discord bot identity. The pool manages
 * creation, hot-reload, and teardown of those per-agent Client instances.
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Message,
} from "discord.js";
import type { EventBus } from "../../types.ts";
import type { ChannelRegistry } from "../../channels/channel-registry.ts";
import { loadAgentPoolDefs } from "./core.ts";

export type HandleDMFn = (
  message: Message,
  agentName: string | undefined,
  bus: EventBus,
) => Promise<void>;

export interface AgentPool {
  /** Initialize the pool, creating clients for all configured agents. */
  init(handleDM: HandleDMFn): void;
  /** Hot-reload: remove clients for agents removed from config, add new ones. */
  reload(): void;
  getClient(agentId: string): Client | undefined;
  entries(): IterableIterator<[string, Client]>;
  destroy(): void;
}

export function createAgentPool(opts: {
  workspaceDir: string;
  channelRegistry?: ChannelRegistry;
  busRef: EventBus;
}): AgentPool {
  const { workspaceDir, channelRegistry, busRef } = opts;
  const agentClients = new Map<string, Client>();
  let _handleDM: HandleDMFn | null = null;

  // Full intents + DM handler — used during initial pool creation
  function spawnForInit(agentName: string, token: string): void {
    try {
      const agentClient = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.MessageContent,
          GatewayIntentBits.DirectMessages,
        ],
        partials: [Partials.Channel, Partials.Message],
      });

      agentClient.once(Events.ClientReady, c => {
        console.log(`[discord] Agent client "${agentName}" logged in as ${c.user.tag}`);
      });

      // Handle DMs sent directly to this agent's bot
      agentClient.on(Events.MessageCreate, async (message) => {
        if (message.author.bot) return;
        if (message.guild) return; // guild messages handled by main client
        await _handleDM!(message, agentName, busRef);
      });

      agentClient.login(token).catch(err => {
        console.warn(`[discord] Agent client "${agentName}" login failed:`, err);
        agentClients.delete(agentName);
      });

      agentClients.set(agentName, agentClient);
    } catch (err) {
      console.warn(`[discord] Failed to create client for agent "${agentName}":`, err);
    }
  }

  // Minimal intents, no DM handler — used during hot-reload for new agents
  function spawnForReload(agentName: string, token: string): void {
    try {
      const agentClient = new Client({
        intents: [GatewayIntentBits.Guilds],
      });

      agentClient.once(Events.ClientReady, c => {
        console.log(`[discord] Agent client "${agentName}" logged in as ${c.user.tag}`);
      });

      agentClient.login(token).catch(err => {
        console.warn(`[discord] Agent client "${agentName}" login failed:`, err);
        agentClients.delete(agentName);
      });

      agentClients.set(agentName, agentClient);
      console.log(`[discord] Pool: added agent client "${agentName}"`);
    } catch (err) {
      console.warn(`[discord] Failed to create client for agent "${agentName}":`, err);
    }
  }

  return {
    init(handleDM: HandleDMFn): void {
      _handleDM = handleDM;

      // Sources: agents.yaml (legacy) + channels.yaml (preferred)
      const agentsYamlEntries = loadAgentPoolDefs(workspaceDir)
        .filter(a => a.discordBotTokenEnvKey)
        .map(a => ({ name: a.name, tokenEnvKey: a.discordBotTokenEnvKey! }));

      const channelEntries = channelRegistry
        ? Array.from(channelRegistry.getDiscordBotTokenEnvs().entries())
            .map(([name, tokenEnvKey]) => ({ name, tokenEnvKey }))
        : [];

      // Merge — channels.yaml wins on conflict
      const byName = new Map<string, string>();
      for (const { name, tokenEnvKey } of [...agentsYamlEntries, ...channelEntries]) {
        byName.set(name, tokenEnvKey);
      }

      let created = 0;
      for (const [agentName, tokenEnvKey] of byName) {
        const token = process.env[tokenEnvKey];
        if (!token) {
          console.warn(`[discord] No token for agent "${agentName}" (env: ${tokenEnvKey}) — will use bus bot`);
          continue;
        }
        spawnForInit(agentName, token);
        created++;
      }

      console.log(`[discord] Agent client pool: ${created} client(s) initialized (${byName.size} agents configured)`);
    },

    reload(): void {
      const agents = loadAgentPoolDefs(workspaceDir);
      const newAgentNames = new Set(
        agents
          .filter(a => a.discordBotTokenEnvKey && process.env[a.discordBotTokenEnvKey!])
          .map(a => a.name)
      );

      // Remove clients for agents no longer in config
      for (const [name, client] of agentClients) {
        if (!newAgentNames.has(name)) {
          client.destroy();
          agentClients.delete(name);
          console.log(`[discord] Pool: removed agent client "${name}"`);
        }
      }

      // Add clients for new agents
      for (const agent of agents) {
        if (!agent.discordBotTokenEnvKey) continue;
        if (agentClients.has(agent.name)) continue; // already active
        const token = process.env[agent.discordBotTokenEnvKey];
        if (!token) continue;
        spawnForReload(agent.name, token);
      }

      console.log(`[discord] Pool reloaded: ${agentClients.size} active agent client(s)`);
    },

    getClient(agentId: string): Client | undefined {
      return agentClients.get(agentId);
    },

    entries(): IterableIterator<[string, Client]> {
      return agentClients.entries();
    },

    destroy(): void {
      for (const [name, client] of agentClients) {
        client.destroy();
        console.log(`[discord] Destroyed agent client: ${name}`);
      }
      agentClients.clear();
    },
  };
}
