/**
 * discord/core.ts — config types, loaders, and shared utilities.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  Client,
  GatewayIntentBits,
  Partials,
  type ChatInputCommandInteraction,
} from "discord.js";

// ── Config types ───────────────────────────────────────────────────────────────

export interface CommandOption {
  name: string;
  description: string;
  type: "string" | "integer" | "boolean";
  required?: boolean;
  /** When true, Discord sends autocomplete interactions for this option. */
  autocomplete?: boolean;
}

export interface Subcommand {
  name: string;
  description: string;
  content: string;
  skillHint?: string;
  options?: CommandOption[];
}

export interface CommandConfig {
  name: string;
  description: string;
  /** Subcommand-based commands (mutually exclusive with top-level `options`). */
  subcommands?: Subcommand[];
  /** Top-level options for flat commands (no subcommands). */
  options?: CommandOption[];
  /** Content template for flat commands — supports {optionName} placeholders. */
  content?: string;
  skillHint?: string;
}

export interface DiscordConfig {
  channels: {
    digest?: string;
    welcome?: string;
    modLog?: string;
  };
  moderation: {
    rateLimit: {
      maxMessages: number;
      windowSeconds: number;
    };
    spamPatterns: string[];
  };
  commands: CommandConfig[];
  admins?: string[];
}

// ── Agent pool types ──────────────────────────────────────────────────────────

export interface AgentPoolEntry {
  name: string;
  discordBotTokenEnvKey?: string;
}

export interface AgentsYaml {
  agents: AgentPoolEntry[];
}

// ── Project types ─────────────────────────────────────────────────────────────

export interface ProjectEntry {
  slug: string;
  title: string;
  github?: string;
  status?: string;
  discord?: { general?: string; updates?: string; dev?: string };
}

export interface ProjectsYaml {
  projects: ProjectEntry[];
}

// ── Shared handle type ────────────────────────────────────────────────────────

export type PendingReply = {
  message?: import("discord.js").Message;
  interaction?: ChatInputCommandInteraction;
};

// ── Discord option type codes ─────────────────────────────────────────────────

export const OPTION_TYPE_CODES: Record<string, number> = {
  string: 3,
  integer: 4,
  boolean: 5,
};

// ── Config loaders ─────────────────────────────────────────────────────────────

export function loadConfig(workspaceDir: string): DiscordConfig {
  const configPath = join(workspaceDir, "discord.yaml");
  if (!existsSync(configPath)) {
    console.log("[discord] No discord.yaml found — using defaults");
    return {
      channels: {},
      moderation: {
        rateLimit: { maxMessages: 5, windowSeconds: 10 },
        spamPatterns: [],
      },
      commands: [],
    };
  }
  return parseYaml(readFileSync(configPath, "utf8")) as DiscordConfig;
}

export function loadAgentPoolDefs(workspaceDir: string): AgentPoolEntry[] {
  const agentsPath = join(workspaceDir, "agents.yaml");
  if (!existsSync(agentsPath)) return [];
  try {
    const raw = readFileSync(agentsPath, "utf8");
    const parsed = parseYaml(raw) as AgentsYaml;
    return parsed.agents ?? [];
  } catch (err) {
    console.error("[discord] Failed to parse agents.yaml:", err);
    return [];
  }
}

export function loadProjectsDefs(workspaceDir: string): ProjectEntry[] {
  const projectsPath = join(workspaceDir, "projects.yaml");
  if (!existsSync(projectsPath)) return [];
  try {
    const raw = readFileSync(projectsPath, "utf8");
    const parsed = parseYaml(raw) as ProjectsYaml;
    return (parsed.projects ?? []).filter(
      p => p.status !== "archived" && p.status !== "suspended"
    );
  } catch (err) {
    console.error("[discord] Failed to parse projects.yaml:", err);
    return [];
  }
}

// ── Spam pattern compilation ──────────────────────────────────────────────────

/**
 * Compile spam pattern strings to RegExp objects.
 * Invalid or catastrophically-backtracking patterns are skipped with a warning.
 */
export function compileSpamPatterns(patterns: string[]): RegExp[] {
  return patterns.flatMap(p => {
    try {
      // Basic ReDoS guard: reject patterns with nested quantifiers like (a+)+
      if (/(\([^)]*[+*][^)]*\))[+*?]/.test(p)) {
        console.warn(`[discord] Skipping potentially unsafe spam pattern (nested quantifiers): "${p}"`);
        return [];
      }
      return [new RegExp(p, "i")];
    } catch (err) {
      console.warn(`[discord] Skipping invalid spam pattern "${p}":`, err);
      return [];
    }
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function makeId(): string {
  return crypto.randomUUID();
}

export function isAdmin(userId: string, admins?: string[]): boolean {
  if (!admins?.length) return true; // open if no list configured
  return admins.includes(userId);
}

// ── Slash command utilities ────────────────────────────────────────────────────

/** Replace {optionName} tokens in a content template with actual interaction values. */
export function interpolateContent(
  template: string,
  options: CommandOption[],
  interaction: ChatInputCommandInteraction,
): string {
  let result = template;
  for (const opt of options) {
    const placeholder = `{${opt.name}}`;
    if (!result.includes(placeholder)) continue;
    let value = "";
    if (opt.type === "string") value = interaction.options.getString(opt.name) ?? "";
    else if (opt.type === "integer") value = String(interaction.options.getInteger(opt.name) ?? "");
    else if (opt.type === "boolean") value = String(interaction.options.getBoolean(opt.name) ?? "");
    result = result.replaceAll(placeholder, value);
  }
  return result.trim();
}

/** Register slash commands with the Discord guild. */
export async function registerSlashCommands(client: Client, config: DiscordConfig): Promise<void> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) {
    console.log("[discord] DISCORD_GUILD_ID not set — skipping slash command registration");
    return;
  }
  const guild = client.guilds.cache.get(guildId);
  if (!guild) { console.log(`[discord] Guild ${guildId} not found`); return; }
  if (!config.commands.length) { console.log("[discord] No commands configured in discord.yaml"); return; }

  const commandData = config.commands.map(cmd => {
    if (cmd.options?.length && !cmd.subcommands?.length) {
      return {
        name: cmd.name,
        description: cmd.description,
        options: cmd.options.map(opt => ({
          name: opt.name, description: opt.description,
          type: OPTION_TYPE_CODES[opt.type] ?? 3,
          required: opt.required ?? false, autocomplete: opt.autocomplete ?? false,
        })),
      };
    }
    return {
      name: cmd.name,
      description: cmd.description,
      options: (cmd.subcommands ?? []).map(sub => ({
        name: sub.name, type: 1, description: sub.description,
        options: (sub.options ?? []).map(opt => ({
          name: opt.name, description: opt.description,
          type: OPTION_TYPE_CODES[opt.type] ?? 3, required: opt.required ?? false,
        })),
      })),
    };
  });

  await guild.commands.set(commandData);
  console.log(`[discord] Registered ${commandData.length} command(s): ${commandData.map(c => `/${c.name}`).join(", ")}`);
}

// ── Main client factory ───────────────────────────────────────────────────────

export function createMainClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction],
  });
}
