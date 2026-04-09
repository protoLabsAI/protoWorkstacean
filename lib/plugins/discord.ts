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

import { readFileSync, existsSync, watchFile, unwatchFile, mkdirSync } from "node:fs";
import type { ChannelRegistry } from "../channels/channel-registry.ts";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { Database } from "bun:sqlite";
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type ChatInputCommandInteraction,
  type TextChannel,
} from "discord.js";
import type { EventBus, BusMessage, Plugin, HITLRequest } from "../types.ts";
import type { HITLPlugin } from "./hitl.ts";
import { ConversationManager } from "../conversation/conversation-manager.ts";
import { ConversationTracer, type TurnData } from "../conversation/conversation-tracer.ts";

// ── Config types ──────────────────────────────────────────────────────────────

interface CommandOption {
  name: string;
  description: string;
  type: "string" | "integer" | "boolean";
  required?: boolean;
  /** When true, Discord sends autocomplete interactions for this option. */
  autocomplete?: boolean;
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
  /** Subcommand-based commands (mutually exclusive with top-level `options`). */
  subcommands?: Subcommand[];
  /** Top-level options for flat commands (no subcommands). */
  options?: CommandOption[];
  /** Content template for flat commands — supports {optionName} placeholders. */
  content?: string;
  skillHint?: string;
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

// ── Spam pattern compilation ──────────────────────────────────────────────────

/**
 * Compile spam pattern strings to RegExp objects.
 * Invalid or catastrophically-backtracking patterns are skipped with a warning
 * rather than crashing the plugin.
 */
function compileSpamPatterns(patterns: string[]): RegExp[] {
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

// ── Pending reply handles ─────────────────────────────────────────────────────
// Kept outside the bus payload so the SQLite logger never tries to serialize them.

const pendingReplies = new Map<
  string,
  { message?: Message; interaction?: ChatInputCommandInteraction }
>();

function makeId(): string {
  return crypto.randomUUID();
}

// ── Agent client pool types ──────────────────────────────────────────────────

interface AgentPoolEntry {
  name: string;
  discordBotTokenEnvKey?: string;
}

interface AgentsYaml {
  agents: AgentPoolEntry[];
}

function loadAgentPoolDefs(workspaceDir: string): AgentPoolEntry[] {
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

// ── Projects loader (for autocomplete + project resolution) ───────────────────

interface ProjectEntry {
  slug: string;
  title: string;
  github?: string;
  status?: string;
  discord?: { general?: string; updates?: string; dev?: string };
}

interface ProjectsYaml {
  projects: ProjectEntry[];
}

function loadProjectsDefs(workspaceDir: string): ProjectEntry[] {
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

// ── Plugin ────────────────────────────────────────────────────────────────────

export class DiscordPlugin implements Plugin {
  readonly name = "discord";
  readonly description = "Discord gateway — routes messages to/from the A2A agent fleet";
  readonly capabilities = ["discord-inbound", "discord-outbound"];

  private client!: Client;
  private busRef!: EventBus;
  private config!: DiscordConfig;
  private workspaceDir: string;

  // Per-agent Discord client pool (agentName → Client)
  private agentClients = new Map<string, Client>();

  // correlationId → agentName — tracks which agent should reply for a pending message
  private pendingAgents = new Map<string, string>();

  private channelRegistry?: ChannelRegistry;
  private hitlPlugin?: HITLPlugin;

  // correlationId → { message, replyTopic } for active HITL approvals
  private pendingHITLMessages = new Map<string, { message: Message; replyTopic: string }>();

  // Multi-turn conversation tracking
  private conversationManager = new ConversationManager();
  private conversationTracer = new ConversationTracer();
  // correlationId (= conversationId for conv turns) → pending Langfuse turn data
  private pendingTurns = new Map<string, TurnData>();

  // Runtime rate-limit state (built from config on install)
  private rateLimits = new Map<string, number[]>();
  private rateMaxMessages = 5;
  private rateWindowMs = 10_000;
  private spamPatterns: RegExp[] = [];

  // Persistent rate-limit DB
  private rlDb: Database | null = null;
  private dataDir: string | null = null;

  constructor(workspaceDir: string, dataDir?: string, channelRegistry?: ChannelRegistry, hitlPlugin?: HITLPlugin) {
    this.workspaceDir = workspaceDir;
    this.dataDir = dataDir ? resolve(dataDir) : null;
    this.channelRegistry = channelRegistry;
    this.hitlPlugin = hitlPlugin;

    // When a conversation times out, finalize its Langfuse trace
    this.conversationManager.setTimeoutCallback((entry) => {
      this.conversationTracer.endTrace({
        conversationId: entry.conversationId,
        turnCount: entry.turnNumber,
        endedBy: "timeout",
      }).catch(err => console.error("[discord] Langfuse endTrace error:", err));
    });
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
    this.spamPatterns = compileSpamPatterns(spamPatterns);

    // Open persistent rate-limit store
    this._openRateLimitDb();

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

      // DMs — auto conversation, no @mention needed, main bot has no assigned agent
      if (!message.guild) {
        await this._handleDM(message, undefined, bus);
        return;
      }

      const isMentioned = message.mentions.has(this.client.user!);
      const userId = message.author.id;

      // Look up channel config early — needed for conversation settings check
      const channelEntry = this.channelRegistry?.findByTopic(`message.inbound.discord.${message.channelId}`);
      const convConfig = channelEntry?.conversation;
      const convEnabled = convConfig?.enabled === true;

      // Allow continuing an active conversation without an @mention
      const continueWithoutMention =
        convEnabled &&
        convConfig?.requireMentionAfterFirst !== true &&
        this.conversationManager.has(message.channelId, userId);

      if (!isMentioned && !continueWithoutMention) return;

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

      // Determine correlationId — stable across turns when conversation is enabled
      let correlationId: string;
      let isNewConversation = false;
      let turnNumber = 1;

      if (convEnabled) {
        const conv = this.conversationManager.getOrCreate(
          message.channelId,
          userId,
          convConfig?.timeoutMs ?? 5 * 60_000,
          channelEntry?.agent,
        );
        correlationId = conv.conversationId;
        isNewConversation = conv.isNew;
        turnNumber = conv.turnNumber;
      } else {
        correlationId = makeId();
      }

      pendingReplies.set(correlationId, { message });

      if (channelEntry?.agent) {
        this.pendingAgents.set(correlationId, channelEntry.agent);
      }

      const content = message.cleanContent
        .replace(/<@!?\d+>/g, "")
        .trim();

      // Langfuse conversation tracing
      if (convEnabled) {
        if (isNewConversation) {
          this.conversationTracer.startTrace({
            conversationId: correlationId,
            userId,
            channelId: message.channelId,
            agentName: channelEntry?.agent,
            platform: "discord",
          }).catch(err => console.error("[discord] Langfuse startTrace error:", err));
        }
        // Store turn data — output is filled in when the agent responds
        this.pendingTurns.set(correlationId, {
          conversationId: correlationId,
          turnNumber,
          input: content,
          userId,
          agentName: channelEntry?.agent,
          startTime: new Date(),
        });
      }

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
          ...(channelEntry?.agent ? { agentId: channelEntry.agent } : {}),
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

    // ── Slash commands + autocomplete ────────────────────────────────────────
    this.client.on(Events.InteractionCreate, async interaction => {
      // ── Autocomplete: filter projects.yaml by typed value ─────────────────
      if (interaction.isAutocomplete()) {
        const cmdConfig = this.config.commands.find(c => c.name === interaction.commandName);
        if (!cmdConfig) return;

        const focused = interaction.options.getFocused(true);
        if (focused.name === "project") {
          const projects = loadProjectsDefs(this.workspaceDir);
          const typed = focused.value.toLowerCase();
          const choices = projects
            .filter(p =>
              p.slug.toLowerCase().includes(typed) ||
              p.title.toLowerCase().includes(typed)
            )
            .slice(0, 25)
            .map(p => ({ name: p.title, value: p.slug }));
          await interaction.respond(choices).catch(console.error);
        }
        return;
      }

      // ── HITL button interactions ─────────────────────────────────────────
      if (interaction.isButton() && interaction.customId.startsWith("hitl:")) {
        const [, decision, correlationId] = interaction.customId.split(":");
        await interaction.deferUpdate();

        const entry = this.pendingHITLMessages.get(correlationId);
        const replyTopic = entry?.replyTopic
          ?? `hitl.response.${correlationId.split("-")[0]}.${correlationId}`;

        bus.publish(replyTopic, {
          id: crypto.randomUUID(),
          correlationId,
          topic: replyTopic,
          timestamp: Date.now(),
          payload: {
            type: "hitl_response",
            correlationId,
            decision: decision as "approve" | "reject" | "modify",
            decidedBy: interaction.user.id,
          },
        });

        if (entry) this.pendingHITLMessages.delete(correlationId);

        const color = decision === "approve" ? 0x22c55e
          : decision === "reject"  ? 0xef4444
          : 0x6b7280;
        const label = decision.charAt(0).toUpperCase() + decision.slice(1);
        const decidedEmbed = new EmbedBuilder()
          .setTitle(interaction.message.embeds[0]?.title ?? "Decision recorded")
          .setDescription(`**${label}** by <@${interaction.user.id}>`)
          .setColor(color);

        await interaction.message.edit({ embeds: [decidedEmbed], components: [] }).catch(console.error);
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      const cmdConfig = this.config.commands.find(c => c.name === interaction.commandName);
      if (!cmdConfig) return;

      if (!this._isAdmin(interaction.user.id)) {
        console.log(`[discord] slash command from ${interaction.user.id} ignored — not in admins list`);
        await interaction.reply({ content: "Not authorised.", ephemeral: true }).catch(() => {});
        return;
      }

      await interaction.deferReply();

      // ── Flat command (top-level options, no subcommands) ─────────────────
      const isFlatCommand = !!cmdConfig.options?.length && !cmdConfig.subcommands?.length;
      if (isFlatCommand) {
        // Resolve project metadata from projects.yaml if a `project` option is present
        const projectSlug = interaction.options.getString("project");
        let devChannelId: string | undefined;
        let projectRepo: string | undefined;

        if (projectSlug) {
          const projects = loadProjectsDefs(this.workspaceDir);
          const project = projects.find(p => p.slug === projectSlug);
          if (project) {
            devChannelId = project.discord?.dev || undefined;
            projectRepo = project.github || undefined;
          }
        }

        const content = this._interpolateContent(
          cmdConfig.content ?? "",
          cmdConfig.options ?? [],
          interaction,
        );

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
            skillHint: cmdConfig.skillHint,
            ...(devChannelId ? { devChannelId } : {}),
            ...(projectRepo ? { projectRepo } : {}),
          },
          source: { interface: "discord" as const, channelId: interaction.channelId, userId: interaction.user.id },
          reply: { topic: `message.outbound.discord.${topicSuffix}` },
        });
        return;
      }

      // ── Subcommand-based command (existing behaviour) ─────────────────────
      const subcommands = cmdConfig.subcommands ?? [];
      const subName = interaction.options.getSubcommand(false) ?? subcommands[0]?.name;
      const subConfig = subcommands.find(s => s.name === subName) ?? subcommands[0];

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
      const content = String(payload.content ?? "").slice(0, 2000);
      if (!content) return; // drop empty outbound messages silently
      const correlationId = msg.correlationId;

      // Resolve agent-specific client — payload.agentId wins, then pendingAgents map
      const agentId = (payload.agentId as string | undefined)
        ?? (correlationId ? this.pendingAgents.get(correlationId) : undefined);
      const agentClient = agentId ? this.agentClients.get(agentId) : undefined;
      if (agentId && !agentClient) {
        console.debug(`[discord] No pool client for agent "${agentId}" — falling back to bus client`);
      }

      // 1. Pending reply from a prior inbound message
      if (correlationId) {
        const pending = pendingReplies.get(correlationId);
        if (pending) {
          pendingReplies.delete(correlationId);
          this.pendingAgents.delete(correlationId);

          // Finalize Langfuse generation for this conversation turn
          const pendingTurn = this.pendingTurns.get(correlationId);
          if (pendingTurn) {
            this.pendingTurns.delete(correlationId);
            this.conversationTracer.traceTurn({
              ...pendingTurn,
              output: content,
              endTime: new Date(),
            }).catch(err => console.error("[discord] Langfuse traceTurn error:", err));
          }

          if (pending.interaction) {
            // Slash command interactions always use the bus client
            await pending.interaction.editReply({ content }).catch(console.error);
            return;
          }

          if (pending.message) {
            const isDM = !pending.message.guild;

            if (isDM) {
              // DMs: reply directly through the message's own channel (works for any bot client)
              await (pending.message.channel as TextChannel).send({ content }).catch(console.error);
            } else if (agentClient) {
              // Guild message via agent's bot identity
              const ch = agentClient.channels.cache.get(pending.message.channelId) as TextChannel | undefined;
              if (ch) {
                console.debug(`[discord] Routing reply via agent client "${agentId}"`);
                await ch.send({ content }).catch(console.error);
              } else {
                console.warn(`[discord] Agent "${agentId}" channel cache miss — falling back to bus client`);
                await pending.message.reply({ content }).catch(console.error);
              }
            } else {
              const reply = await pending.message.reply({ content }).catch(console.error);
              // Start a thread on first guild response if not already in one
              if (reply && !pending.message.channel.isThread()) {
                await reply.startThread({ name: content.slice(0, 50) || "Response" }).catch(() => {});
              }
            }

            // Reactions: only in guild channels (the main client owns them there)
            if (!isDM) {
              await pending.message.reactions.resolve("👀")?.users.remove(this.client.user!).catch(() => {});
              await pending.message.react("✅").catch(() => {});
            }
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
        const sendClient = agentClient ?? this.client;
        if (agentClient) {
          console.debug(`[discord] Routing push to channel ${channelId} via agent client "${agentId}"`);
        }
        const ch = sendClient.channels.cache.get(channelId) as TextChannel | undefined;
        await ch?.send({ content }).catch(console.error);
      }
    });

    // ── HITL renderer registration ───────────────────────────────────────────
    if (this.hitlPlugin) {
      this.hitlPlugin.registerRenderer("discord", {
        render: async (request, _busRef) => {
          const channelId = request.sourceMeta?.channelId;
          if (!channelId) {
            console.warn(`[discord] HITL ${request.correlationId} missing channelId — cannot render`);
            return;
          }
          const ch = this.client.channels.cache.get(channelId) as TextChannel | undefined;
          if (!ch) {
            console.warn(`[discord] HITL channel ${channelId} not in cache — cannot render`);
            return;
          }
          const embed = this._buildHITLEmbed(request);
          const row = this._buildHITLButtons(request);
          const msg = await ch.send({ embeds: [embed], components: [row] });
          this.pendingHITLMessages.set(request.correlationId, {
            message: msg,
            replyTopic: request.replyTopic,
          });
          console.log(`[discord] HITL ${request.correlationId} rendered in channel ${channelId}`);
        },
        onExpired: async (request, _busRef) => {
          const entry = this.pendingHITLMessages.get(request.correlationId);
          if (!entry) return;
          this.pendingHITLMessages.delete(request.correlationId);
          const expiredEmbed = new EmbedBuilder()
            .setTitle(request.title)
            .setDescription("**Approval expired** — re-trigger if still needed.")
            .setColor(0x6b7280);
          await entry.message.edit({ embeds: [expiredEmbed], components: [] }).catch(console.error);
          console.log(`[discord] HITL ${request.correlationId} marked expired`);
        },
      });
    }

    // ── Hot-reload discord.yaml ───────────────────────────────────────────────
    // watchFile works even if the file doesn't exist yet (detects creation too).
    const configPath = join(this.workspaceDir, "discord.yaml");
    watchFile(configPath, { interval: 5_000 }, async () => {
      const prev = this.config;
      this.config = loadConfig(this.workspaceDir);

      // Apply updated moderation config
      const { rateLimit, spamPatterns } = this.config.moderation;
      this.rateMaxMessages = rateLimit.maxMessages;
      this.rateWindowMs = rateLimit.windowSeconds * 1_000;
      this.spamPatterns = compileSpamPatterns(spamPatterns);

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

    // ── Bus client login ────────────────────────────────────────────────────
    this.client.login(process.env.DISCORD_BOT_TOKEN);

    // ── Agent client pool initialization ────────────────────────────────────
    this._initAgentPool();

    // ── Hot-reload agent pool on agents.yaml changes ────────────────────────
    const agentsPath = join(this.workspaceDir, "agents.yaml");
    if (existsSync(agentsPath)) {
      watchFile(agentsPath, { interval: 5_000 }, () => {
        console.log("[discord] agents.yaml changed — reloading agent client pool");
        this._reloadAgentPool();
      });
    }
  }

  uninstall(): void {
    this.conversationManager.destroy();
    this.pendingTurns.clear();
    this.pendingHITLMessages.clear();

    // Destroy agent pool clients
    for (const [name, client] of this.agentClients) {
      client.destroy();
      console.log(`[discord] Destroyed agent client: ${name}`);
    }
    this.agentClients.clear();

    // Stop watching config files
    unwatchFile(join(this.workspaceDir, "discord.yaml"));
    unwatchFile(join(this.workspaceDir, "agents.yaml"));

    this.client?.destroy();

    if (this.rlDb) {
      this.rlDb.close();
      this.rlDb = null;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _isAdmin(userId: string): boolean {
    if (!this.config.admins?.length) return true; // open if no list configured
    return this.config.admins.includes(userId);
  }

  private _openRateLimitDb(): void {
    if (!this.dataDir) return;

    try {
      if (!existsSync(this.dataDir)) {
        mkdirSync(this.dataDir, { recursive: true });
      }

      this.rlDb = new Database(join(this.dataDir, "events.db"));
      this.rlDb.exec("PRAGMA journal_mode=WAL");
      this.rlDb.exec(`
        CREATE TABLE IF NOT EXISTS rate_limits (
          user_id TEXT NOT NULL,
          ts INTEGER NOT NULL
        )
      `);
      this.rlDb.exec("CREATE INDEX IF NOT EXISTS idx_rate_limits_user_ts ON rate_limits(user_id, ts)");

      // Load persisted windows into memory
      const cutoff = Date.now() - this.rateWindowMs;
      const rows = this.rlDb
        .query("SELECT user_id, ts FROM rate_limits WHERE ts > ?")
        .all(cutoff) as { user_id: string; ts: number }[];

      for (const row of rows) {
        const hits = this.rateLimits.get(row.user_id) ?? [];
        hits.push(row.ts);
        this.rateLimits.set(row.user_id, hits);
      }

      console.log(`[discord] Rate-limit DB opened (${rows.length} persisted hit(s) loaded)`);
    } catch (err) {
      console.warn("[discord] Could not open rate-limit DB — falling back to in-memory only:", err);
      this.rlDb = null;
    }
  }

  private _isRateLimited(userId: string): boolean {
    const now = Date.now();
    const hits = (this.rateLimits.get(userId) ?? []).filter(t => now - t < this.rateWindowMs);
    hits.push(now);
    this.rateLimits.set(userId, hits);

    // Persist new hit to DB (fire-and-forget; errors are non-fatal)
    if (this.rlDb) {
      try {
        this.rlDb.run("INSERT INTO rate_limits (user_id, ts) VALUES (?, ?)", [userId, now]);
        // Prune expired rows for this user to keep the table tidy
        this.rlDb.run("DELETE FROM rate_limits WHERE user_id = ? AND ts <= ?", [userId, now - this.rateWindowMs]);
      } catch (err) {
        console.warn("[discord] Failed to persist rate-limit hit:", err);
      }
    }

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

  private _buildHITLEmbed(request: HITLRequest): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setTitle(request.title)
      .setDescription(request.summary.slice(0, 4096))
      .setColor(0xf59e0b);

    if (request.avaVerdict) {
      embed.addFields({
        name: `Ava verdict (score: ${request.avaVerdict.score})`,
        value: request.avaVerdict.verdict.slice(0, 1024),
        inline: false,
      });
    }
    if (request.jonVerdict) {
      embed.addFields({
        name: `Jon verdict (score: ${request.jonVerdict.score})`,
        value: request.jonVerdict.verdict.slice(0, 1024),
        inline: false,
      });
    }
    if (request.escalationContext) {
      const ctx = request.escalationContext;
      embed.addFields({
        name: "Cost",
        value: `Est: **$${ctx.estimatedCost.toFixed(4)}** | Max: $${ctx.maxCost.toFixed(4)} | Tier: ${ctx.tier}`,
        inline: false,
      });
    }

    embed.setFooter({ text: `Expires ${new Date(request.expiresAt).toLocaleString()}` });
    return embed;
  }

  private _buildHITLButtons(request: HITLRequest): ActionRowBuilder<ButtonBuilder> {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (const option of request.options) {
      const style =
        option === "approve" ? ButtonStyle.Success :
        option === "reject"  ? ButtonStyle.Danger  :
                               ButtonStyle.Secondary;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`hitl:${option}:${request.correlationId}`)
          .setLabel(option.charAt(0).toUpperCase() + option.slice(1))
          .setStyle(style),
      );
    }
    return row;
  }

  /**
   * Handle an inbound DM — called from both the main bot and agent pool bots.
   *
   * DMs are always conversation-enabled (no channels.yaml entry needed).
   * The stable conversationId becomes the A2A contextId, giving the agent
   * full memory of the exchange across turns.
   *
   * agentName is undefined when the main bus bot receives the DM (routed by
   * A2A keyword matching). When an agent pool bot receives it, agentName is
   * the specific agent so the A2A layer routes directly.
   */
  private async _handleDM(message: Message, agentName: string | undefined, bus: EventBus): Promise<void> {
    const userId = message.author.id;

    if (!this._isAdmin(userId)) return;
    if (this._isSpam(message.content)) { await message.delete().catch(() => {}); return; }
    if (this._isRateLimited(userId)) {
      await (message.channel as TextChannel).send("Easy there — you're sending messages too quickly.").catch(() => {});
      return;
    }

    const timeoutMs = Number(process.env.DM_CONVERSATION_TIMEOUT_MS ?? 15 * 60_000);
    const conv = this.conversationManager.getOrCreate(message.channelId, userId, timeoutMs, agentName);
    const { conversationId, isNew, turnNumber } = conv;

    pendingReplies.set(conversationId, { message });
    if (agentName) this.pendingAgents.set(conversationId, agentName);

    const content = message.cleanContent.replace(/<@!?\d+>/g, "").trim();
    if (!content) return;

    // Langfuse tracing
    if (isNew) {
      this.conversationTracer.startTrace({
        conversationId,
        userId,
        channelId: message.channelId,
        agentName,
        platform: "discord-dm",
      }).catch(err => console.error("[discord] Langfuse startTrace error:", err));
    }
    this.pendingTurns.set(conversationId, {
      conversationId,
      turnNumber,
      input: content,
      userId,
      agentName,
      startTime: new Date(),
    });

    bus.publish(`message.inbound.discord.${message.channelId}`, {
      id: message.id,
      correlationId: conversationId,
      topic: `message.inbound.discord.${message.channelId}`,
      timestamp: Date.now(),
      payload: {
        sender: userId,
        channel: message.channelId,
        content,
        isDM: true,
        ...(agentName ? { agentId: agentName } : {}),
      },
      source: { interface: "discord" as const, channelId: message.channelId, userId },
      reply: { topic: `message.outbound.discord.${message.channelId}` },
    });
  }

  private _initAgentPool(): void {
    // Sources: agents.yaml (legacy) + channels.yaml (preferred)
    const agentsYamlEntries = loadAgentPoolDefs(this.workspaceDir)
      .filter(a => a.discordBotTokenEnvKey)
      .map(a => ({ name: a.name, tokenEnvKey: a.discordBotTokenEnvKey! }));

    const channelEntries = this.channelRegistry
      ? Array.from(this.channelRegistry.getDiscordBotTokenEnvs().entries())
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
          await this._handleDM(message, agentName, this.busRef!);
        });

        agentClient.login(token).catch(err => {
          console.warn(`[discord] Agent client "${agentName}" login failed:`, err);
          this.agentClients.delete(agentName);
        });

        this.agentClients.set(agentName, agentClient);
        created++;
      } catch (err) {
        console.warn(`[discord] Failed to create client for agent "${agentName}":`, err);
      }
    }

    console.log(`[discord] Agent client pool: ${created} client(s) initialized (${byName.size} agents configured)`);
  }

  private _reloadAgentPool(): void {
    const agents = loadAgentPoolDefs(this.workspaceDir);
    const newAgentNames = new Set(
      agents.filter(a => a.discordBotTokenEnvKey && process.env[a.discordBotTokenEnvKey!])
        .map(a => a.name)
    );

    // Remove clients for agents no longer in config
    for (const [name, client] of this.agentClients) {
      if (!newAgentNames.has(name)) {
        client.destroy();
        this.agentClients.delete(name);
        console.log(`[discord] Pool: removed agent client "${name}"`);
      }
    }

    // Add clients for new agents
    for (const agent of agents) {
      if (!agent.discordBotTokenEnvKey) continue;
      if (this.agentClients.has(agent.name)) continue; // already active

      const token = process.env[agent.discordBotTokenEnvKey];
      if (!token) continue;

      try {
        const agentClient = new Client({
          intents: [GatewayIntentBits.Guilds],
        });

        agentClient.once(Events.ClientReady, c => {
          console.log(`[discord] Agent client "${agent.name}" logged in as ${c.user.tag}`);
        });

        agentClient.login(token).catch(err => {
          console.warn(`[discord] Agent client "${agent.name}" login failed:`, err);
          this.agentClients.delete(agent.name);
        });

        this.agentClients.set(agent.name, agentClient);
        console.log(`[discord] Pool: added agent client "${agent.name}"`);
      } catch (err) {
        console.warn(`[discord] Failed to create client for agent "${agent.name}":`, err);
      }
    }

    console.log(`[discord] Pool reloaded: ${this.agentClients.size} active agent client(s)`);
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

    const commandData = this.config.commands.map(cmd => {
      // Flat command: top-level options with optional autocomplete (no subcommands)
      if (cmd.options?.length && !cmd.subcommands?.length) {
        return {
          name: cmd.name,
          description: cmd.description,
          options: cmd.options.map(opt => ({
            name: opt.name,
            description: opt.description,
            type: OPTION_TYPE_CODES[opt.type] ?? 3,
            required: opt.required ?? false,
            autocomplete: opt.autocomplete ?? false,
          })),
        };
      }
      // Subcommand-based command (existing behaviour)
      return {
        name: cmd.name,
        description: cmd.description,
        options: (cmd.subcommands ?? []).map(sub => ({
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
      };
    });

    await guild.commands.set(commandData);
    console.log(
      `[discord] Registered ${commandData.length} command(s): ${commandData.map(c => `/${c.name}`).join(", ")}`
    );
  }
}
