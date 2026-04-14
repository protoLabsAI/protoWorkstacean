/**
 * agent-pool.ts — Multi-bot Discord client pool.
 *
 * Reads DISCORD_BOT_TOKEN_* environment variables (one per agent) and creates
 * dedicated Discord clients so each agent can post with its own bot identity.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Events, type Message } from "discord.js";
import { createAgentClient } from "./core.ts";
import { warmDmChannels } from "./dm-warming.ts";
import type { DiscordContext } from "./core.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentPoolEntry {
  name: string;
  discordBotTokenEnvKey?: string;
}

interface AgentsYaml {
  agents: AgentPoolEntry[];
}

// ── Loader ────────────────────────────────────────────────────────────────────

export function loadAgentPoolDefs(workspaceDir: string): AgentPoolEntry[] {
  const seen = new Map<string, AgentPoolEntry>();

  const agentsPath = join(workspaceDir, "agents.yaml");
  if (existsSync(agentsPath)) {
    try {
      const raw = readFileSync(agentsPath, "utf8");
      const parsed = parseYaml(raw) as AgentsYaml;
      for (const entry of parsed.agents ?? []) {
        if (entry?.name) seen.set(entry.name, entry);
      }
    } catch (err) {
      console.error("[discord] Failed to parse agents.yaml:", err);
    }
  }

  const agentsDir = join(workspaceDir, "agents");
  if (existsSync(agentsDir)) {
    try {
      for (const file of readdirSync(agentsDir)) {
        if (!(file.endsWith(".yaml") || file.endsWith(".yml"))) continue;
        if (file.endsWith(".example") || file.endsWith(".retired")) continue;
        const filePath = join(agentsDir, file);
        try {
          const parsed = parseYaml(readFileSync(filePath, "utf8")) as {
            name?: string;
            discordBotTokenEnvKey?: string;
          };
          if (parsed?.name && typeof parsed.discordBotTokenEnvKey === "string") {
            if (!seen.has(parsed.name)) {
              seen.set(parsed.name, {
                name: parsed.name,
                discordBotTokenEnvKey: parsed.discordBotTokenEnvKey,
              });
            }
          }
        } catch (err) {
          console.error(`[discord] Failed to parse agent file ${file}:`, err);
        }
      }
    } catch (err) {
      console.error("[discord] Failed to enumerate workspace/agents/:", err);
    }
  }

  return Array.from(seen.values());
}

// ── Pool initialization ───────────────────────────────────────────────────────

export function initAgentPool(
  ctx: DiscordContext,
  handleDM: (message: Message, agentName: string | undefined) => Promise<void>,
): void {
  const agentsYamlEntries = loadAgentPoolDefs(ctx.workspaceDir)
    .filter(a => a.discordBotTokenEnvKey)
    .map(a => ({ name: a.name, tokenEnvKey: a.discordBotTokenEnvKey! }));

  const channelEntries = ctx.channelRegistry
    ? Array.from(ctx.channelRegistry.getDiscordBotTokenEnvs().entries())
        .map(([name, tokenEnvKey]) => ({ name, tokenEnvKey }))
    : [];

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

    try {
      const agentClient = createAgentClient();

      agentClient.once(Events.ClientReady, async c => {
        console.log(`[discord] Agent client "${agentName}" logged in as ${c.user.tag}`);
        await warmDmChannels(ctx, c).catch(err =>
          console.warn(`[discord] Agent client "${agentName}" DM pre-warm failed:`, err),
        );
      });

      agentClient.on(Events.MessageCreate, async (message) => {
        if (message.author.bot) return;
        if (message.guild) return;
        console.log(`[discord] Agent client "${agentName}" received DM from ${message.author.tag} (${message.author.id})`);
        await handleDM(message, agentName);
      });

      agentClient.login(token).catch(err => {
        console.warn(`[discord] Agent client "${agentName}" login failed:`, err);
        ctx.agentClients.delete(agentName);
      });

      ctx.agentClients.set(agentName, agentClient);
      created++;
    } catch (err) {
      console.warn(`[discord] Failed to create client for agent "${agentName}":`, err);
    }
  }

  console.log(`[discord] Agent client pool: ${created} client(s) initialized (${byName.size} agents configured)`);
}

// ── Pool reload ───────────────────────────────────────────────────────────────

export function reloadAgentPool(ctx: DiscordContext): void {
  const agents = loadAgentPoolDefs(ctx.workspaceDir);
  const newAgentNames = new Set(
    agents.filter(a => a.discordBotTokenEnvKey && process.env[a.discordBotTokenEnvKey!])
      .map(a => a.name)
  );

  for (const [name, client] of ctx.agentClients) {
    if (!newAgentNames.has(name)) {
      client.destroy();
      ctx.agentClients.delete(name);
      console.log(`[discord] Pool: removed agent client "${name}"`);
    }
  }

  for (const agent of agents) {
    if (!agent.discordBotTokenEnvKey) continue;
    if (ctx.agentClients.has(agent.name)) continue;

    const token = process.env[agent.discordBotTokenEnvKey];
    if (!token) continue;

    try {
      const agentClient = createAgentClient();

      agentClient.once(Events.ClientReady, c => {
        console.log(`[discord] Agent client "${agent.name}" logged in as ${c.user.tag}`);
      });

      agentClient.login(token).catch(err => {
        console.warn(`[discord] Agent client "${agent.name}" login failed:`, err);
        ctx.agentClients.delete(agent.name);
      });

      ctx.agentClients.set(agent.name, agentClient);
      console.log(`[discord] Pool: added agent client "${agent.name}"`);
    } catch (err) {
      console.warn(`[discord] Failed to create client for agent "${agent.name}":`, err);
    }
  }

  console.log(`[discord] Pool reloaded: ${ctx.agentClients.size} active agent client(s)`);
}
