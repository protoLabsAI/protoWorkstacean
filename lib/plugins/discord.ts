/**
 * DiscordPlugin — bridges Discord gateway events to/from the Workstacean bus.
 *
 * Inbound:
 *   @mentions, DMs → message.inbound.discord.{channelId}
 *   📋 reactions   → message.inbound.discord.{channelId}  (skill hint: bug_triage)
 *   slash commands → message.inbound.discord.slash.{interactionId}
 *
 * Outbound:
 *   message.outbound.discord.#  → reply to originating message/interaction
 *   message.outbound.discord.push.{channelId} → unprompted post (cron, etc.)
 *
 * Config: workspace/discord.yaml (channels, moderation, commands)
 *
 * Env vars:
 *   DISCORD_BOT_TOKEN       (required)
 *   DISCORD_GUILD_ID        (required for slash command registration)
 *   DISCORD_DIGEST_CHANNEL  fallback channel ID for cron-triggered posts
 */

import { readFileSync, existsSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  type Message,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import type { EventBus, BusMessage, Plugin } from "../types.ts";

// ── Config types ──────────────────────────────────────────────────────────────

interface CommandOption {
  name: string;
  description: string;
  type: "string" | "integer" | "boolean";
  required?: boolean;
}

interface Subcommand {
  name: string;
  description: string;
  content: string;
  skillHint?: string;
  options?: CommandOption[];
}

interface CommandConfig {
  name: string;
  description: string;
  subcommands: Subcommand[];
}

interface DiscordConfig {
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

function loadConfig(workspaceDir: string): DiscordConfig {
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

// ── Discord option type codes ─────────────────────────────────────────────────

const OPTION_TYPE_CODES: Record<string, number> = {
  string: 3,
  integer: 4,
  boolean: 5,
};

// ── Pending reply handles ─────────────────────────────────────────────────────
// Kept outside the bus payload so the SQLite logger never tries to serialize them.

const pendingReplies = new Map<
  string,
  { message?: Message; interaction?: ChatInputCommandInteraction }
>();

function makeId(): string {
  return crypto.randomUUID();
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class DiscordPlugin implements Plugin {
  readonly name = "discord";
  readonly description = "Discord gateway — routes messages to/from the A2A agent fleet";
  readonly capabilities = ["discord-inbound", "discord-outbound"];

  private client!: Client;
  private busRef!: EventBus;
  private config!: DiscordConfig;
  private workspaceDir: string;

  // Runtime rate-limit state (built from config on install)
  private rateLimits = new Map<string, number[]>();
  private rateMaxMessages = 5;
  private rateWindowMs = 10_000;
  private spamPatterns: RegExp[] = [];

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  install(bus: EventBus): void {
    if (!process.env.DISCORD_BOT_TOKEN) {
      console.log("[discord] DISCORD_BOT_TOKEN not set — plugin disabled");
      return;
    }

    this.busRef = bus;
    this.config = loadConfig(this.workspaceDir);

    // Apply moderation config
    const { rateLimit, spamPatterns } = this.config.moderation;
    this.rateMaxMessages = rateLimit.maxMessages;
    this.rateWindowMs = rateLimit.windowSeconds * 1_000;
    this.spamPatterns = spamPatterns.map(p => new RegExp(p, "i"));

    this.client = new Client({
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

    // ── Ready ────────────────────────────────────────────────────────────────
    this.client.once(Events.ClientReady, async client => {
      console.log(`[discord] Logged in as ${client.user.tag}`);
      await this._registerSlashCommands();
    });

    // ── Message create ───────────────────────────────────────────────────────
    this.client.on(Events.MessageCreate, async message => {
      if (message.author.bot) return;

      const isMentioned = message.mentions.has(this.client.user!);
      const isDM = !message.guild;
      if (!isMentioned && !isDM) return;

      const userId = message.author.id;

      if (!this._isAdmin(userId)) {
        console.log(`[discord] message from ${userId} ignored — not in admins list`);
        return;
      }

      if (this._isSpam(message.content)) {
        await message.delete().catch(() => {});
        return;
      }
      if (this._isRateLimited(userId)) {
        await message.reply("Easy there — you're sending messages too quickly.").catch(() => {});
        return;
      }

      await message.react("👀").catch(() => {});

      const correlationId = makeId();
      pendingReplies.set(correlationId, { message });

      const content = message.cleanContent
        .replace(/<@!?\d+>/g, "")
        .trim();

      bus.publish(`message.inbound.discord.${message.channelId}`, {
        id: message.id,
        correlationId,
        topic: `message.inbound.discord.${message.channelId}`,
        timestamp: Date.now(),
        payload: {
          sender: userId,
          channel: message.channelId,
          content,
          isThread: message.channel.isThread(),
          guildId: message.guildId,
        },
        source: { interface: "discord" as const, channelId: message.channelId, userId },
        reply: { topic: `message.outbound.discord.${message.channelId}` },
      });
    });

    // ── 📋 reaction → bug triage ─────────────────────────────────────────────
    this.client.on(Events.MessageReactionAdd, async (reaction, user) => {
      if (user.bot) return;
      if (reaction.emoji.name !== "📋") return;
      if (!this._isAdmin(user.id)) {
        console.log(`[discord] reaction from ${user.id} ignored — not in admins list`);
        return;
      }

      const message = reaction.partial
        ? await reaction.message.fetch()
        : reaction.message as Message;

      await message.react("👀").catch(() => {});

      const correlationId = makeId();
      pendingReplies.set(correlationId, { message });

      bus.publish(`message.inbound.discord.${message.channelId}`, {
        id: `${message.id}-clip`,
        correlationId,
        topic: `message.inbound.discord.${message.channelId}`,
        timestamp: Date.now(),
        payload: {
          sender: user.id,
          channel: message.channelId,
          content: message.content,
          skillHint: "bug_triage",
          isReaction: true,
        },
        source: { interface: "discord" as const, channelId: message.channelId, userId: user.id },
        reply: { topic: `message.outbound.discord.${message.channelId}` },
      });
    });

    // ── Slash commands ───────────────────────────────────────────────────────
    this.client.on(Events.InteractionCreate, async interaction => {
      if (!interaction.isChatInputCommand()) return;

      const cmdConfig = this.config.commands.find(c => c.name === interaction.commandName);
      if (!cmdConfig) return;

      if (!this._isAdmin(interaction.user.id)) {
        console.log(`[discord] slash command from ${interaction.user.id} ignored — not in admins list`);
        await interaction.reply({ content: "Not authorised.", ephemeral: true }).catch(() => {});
        return;
      }

      await interaction.deferReply();

      const subName = interaction.options.getSubcommand(false) ?? cmdConfig.subcommands[0]?.name;
      const subConfig = cmdConfig.subcommands.find(s => s.name === subName)
        ?? cmdConfig.subcommands[0];

      if (!subConfig) {
        await interaction.editReply("Unknown subcommand.").catch(console.error);
        return;
      }

      // Interpolate {optionName} placeholders from config content template
      const content = this._interpolateContent(subConfig.content, subConfig.options ?? [], interaction);

      const correlationId = makeId();
      pendingReplies.set(correlationId, { interaction });

      const topicSuffix = `slash.${interaction.id}`;
      bus.publish(`message.inbound.discord.${topicSuffix}`, {
        id: interaction.id,
        correlationId,
        topic: `message.inbound.discord.${topicSuffix}`,
        timestamp: Date.now(),
        payload: {
          sender: interaction.user.id,
          channel: interaction.channelId,
          content,
          skillHint: subConfig.skillHint,
        },
        source: { interface: "discord" as const, channelId: interaction.channelId, userId: interaction.user.id },
        reply: { topic: `message.outbound.discord.${topicSuffix}` },
      });
    });

    // ── Welcome new members ──────────────────────────────────────────────────
    this.client.on(Events.GuildMemberAdd, async member => {
      const channelId = this.config.channels.welcome || process.env.DISCORD_WELCOME_CHANNEL;
      if (!channelId) return;
      const ch = member.guild.channels.cache.get(channelId) as TextChannel | undefined;
      await ch?.send(`Welcome to the protoLabs community, <@${member.id}>! 👋`).catch(() => {});
    });

    // ── Outbound: reply to pending messages / interactions ───────────────────
    bus.subscribe("message.outbound.discord.#", "discord-outbound", async (msg: BusMessage) => {
      const payload = msg.payload as Record<string, unknown>;
      const content = String(payload.content ?? "").slice(0, 2000) || "(no response)";
      const correlationId = msg.correlationId;

      // 1. Pending reply from a prior inbound message
      if (correlationId) {
        const pending = pendingReplies.get(correlationId);
        if (pending) {
          pendingReplies.delete(correlationId);

          if (pending.interaction) {
            await pending.interaction.editReply({ content }).catch(console.error);
            return;
          }

          if (pending.message) {
            const reply = await pending.message.reply({ content }).catch(console.error);
            // Start a thread on first response if not already in one
            if (reply && !pending.message.channel.isThread()) {
              await reply.startThread({ name: content.slice(0, 50) || "Response" }).catch(() => {});
            }
            // Update reactions: 👀 → ✅
            await pending.message.reactions.resolve("👀")?.users.remove(this.client.user!).catch(() => {});
            await pending.message.react("✅").catch(() => {});
            return;
          }
        }
      }

      // 2. Unprompted push (cron, proactive notification)
      const channelId = String(
        payload.channel ?? payload.recipient
          ?? this.config.channels.digest
          ?? process.env.DISCORD_DIGEST_CHANNEL
          ?? ""
      );
      if (channelId) {
        const ch = this.client.channels.cache.get(channelId) as TextChannel | undefined;
        await ch?.send({ content }).catch(console.error);
      }
    });

    // ── Hot-reload discord.yaml ───────────────────────────────────────────────
    const configPath = join(this.workspaceDir, "discord.yaml");
    if (existsSync(configPath)) {
      watchFile(configPath, { interval: 5_000 }, async () => {
        const prev = this.config;
        this.config = loadConfig(this.workspaceDir);

        // Apply updated moderation config
        const { rateLimit, spamPatterns } = this.config.moderation;
        this.rateMaxMessages = rateLimit.maxMessages;
        this.rateWindowMs = rateLimit.windowSeconds * 1_000;
        this.spamPatterns = spamPatterns.map(p => new RegExp(p, "i"));

        // Re-register slash commands if command list changed
        const prevCmds = JSON.stringify(prev.commands ?? []);
        const newCmds = JSON.stringify(this.config.commands ?? []);
        if (prevCmds !== newCmds && this.client?.isReady()) {
          console.log("[discord] discord.yaml changed — re-registering slash commands");
          await this._registerSlashCommands().catch(console.error);
        } else {
          console.log("[discord] discord.yaml reloaded");
        }
      });
    }

    this.client.login(process.env.DISCORD_BOT_TOKEN);
  }

  uninstall(): void {
    this.client?.destroy();
    unwatchFile(join(this.workspaceDir, "discord.yaml"));
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _isAdmin(userId: string): boolean {
    if (!this.config.admins?.length) return true; // open if no list configured
    return this.config.admins.includes(userId);
  }

  private _isRateLimited(userId: string): boolean {
    const now = Date.now();
    const hits = (this.rateLimits.get(userId) ?? []).filter(t => now - t < this.rateWindowMs);
    hits.push(now);
    this.rateLimits.set(userId, hits);
    return hits.length > this.rateMaxMessages;
  }

  private _isSpam(content: string): boolean {
    return this.spamPatterns.some(p => p.test(content));
  }

  /** Replace {optionName} tokens in a content template with actual interaction values. */
  private _interpolateContent(
    template: string,
    options: CommandOption[],
    interaction: ChatInputCommandInteraction,
  ): string {
    let result = template;
    for (const opt of options) {
      const placeholder = `{${opt.name}}`;
      if (!result.includes(placeholder)) continue;

      let value = "";
      if (opt.type === "string") {
        value = interaction.options.getString(opt.name) ?? "";
      } else if (opt.type === "integer") {
        value = String(interaction.options.getInteger(opt.name) ?? "");
      } else if (opt.type === "boolean") {
        value = String(interaction.options.getBoolean(opt.name) ?? "");
      }
      result = result.replaceAll(placeholder, value);
    }
    return result.trim();
  }

  private async _registerSlashCommands(): Promise<void> {
    const guildId = process.env.DISCORD_GUILD_ID;
    if (!guildId) {
      console.log("[discord] DISCORD_GUILD_ID not set — skipping slash command registration");
      return;
    }

    const guild = this.client.guilds.cache.get(guildId);
    if (!guild) {
      console.log(`[discord] Guild ${guildId} not found`);
      return;
    }

    if (!this.config.commands.length) {
      console.log("[discord] No commands configured in discord.yaml");
      return;
    }

    const commandData = this.config.commands.map(cmd => ({
      name: cmd.name,
      description: cmd.description,
      options: cmd.subcommands.map(sub => ({
        name: sub.name,
        type: 1, // SUB_COMMAND
        description: sub.description,
        options: (sub.options ?? []).map(opt => ({
          name: opt.name,
          description: opt.description,
          type: OPTION_TYPE_CODES[opt.type] ?? 3,
          required: opt.required ?? false,
        })),
      })),
    }));

    await guild.commands.set(commandData);
    console.log(
      `[discord] Registered ${commandData.length} command(s): ${commandData.map(c => `/${c.name}`).join(", ")}`
    );
  }
}
