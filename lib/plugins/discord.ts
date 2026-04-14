/**
 * DiscordPlugin — plugin shell that wires all Discord submodules together.
 * See lib/plugins/discord/ for module details.
 */

import { watchFile, unwatchFile, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Events, type TextChannel } from "discord.js";
import type { EventBus, Plugin } from "../types.ts";
import type { ChannelRegistry } from "../channels/channel-registry.ts";
import type { HITLPlugin } from "./hitl.ts";
import type { ContextMailbox } from "../dm/context-mailbox.ts";
import { ConversationManager } from "../conversation/conversation-manager.ts";
import { ConversationTracer } from "../conversation/conversation-tracer.ts";
import { IdentityRegistry } from "../identity/identity-registry.ts";

import { loadConfig, createMainClient, buildContext, type DiscordContext } from "./discord/core.ts";
import { compileSpamPatterns, openRateLimitDb } from "./discord/rate-limit.ts";
import { warmDmChannels } from "./discord/dm-warming.ts";
import { initAgentPool, reloadAgentPool } from "./discord/agent-pool.ts";
import { registerInboundHandlers, handleDM, setupDmAccumulator } from "./discord/inbound.ts";
import { registerSlashCommandHandlers, registerSlashCommands } from "./discord/slash-commands.ts";
import { registerOutboundHandlers } from "./discord/outbound.ts";

// Re-export for API routes (discord operations agent)
export { pendingReplies, canSendProgress } from "./discord/outbound.ts";

// ── Plugin options ────────────────────────────────────────────────────────────

export interface DiscordPluginOptions {
  workspaceDir: string;
  dataDir?: string;
  channelRegistry?: ChannelRegistry;
  hitlPlugin?: HITLPlugin;
  mailbox?: ContextMailbox;
  /** Check if an agent execution is in-flight for a given correlationId. */
  isExecutionActive?: (correlationId: string) => boolean;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class DiscordPlugin implements Plugin {
  readonly name = "discord";
  readonly description = "Discord gateway — routes messages to/from the A2A agent fleet";
  readonly capabilities = ["discord-inbound", "discord-outbound"];

  /** Exposed for API routes (discord operations agent). */
  client!: ReturnType<typeof createMainClient>;

  private workspaceDir: string;
  private dataDir: string | null;
  private channelRegistry?: ChannelRegistry;
  private hitlPlugin?: HITLPlugin;
  private mailbox?: ContextMailbox;
  private isExecutionActive?: (correlationId: string) => boolean;

  private conversationManager = new ConversationManager();
  private conversationTracer = new ConversationTracer();
  private ctx: DiscordContext | null = null;

  constructor(opts: DiscordPluginOptions) {
    this.workspaceDir = opts.workspaceDir;
    this.dataDir = opts.dataDir ? resolve(opts.dataDir) : null;
    this.channelRegistry = opts.channelRegistry;
    this.hitlPlugin = opts.hitlPlugin;
    this.mailbox = opts.mailbox;
    this.isExecutionActive = opts.isExecutionActive;

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

    const config = loadConfig(this.workspaceDir);
    this.client = createMainClient();

    const ctx = buildContext({
      bus,
      config,
      workspaceDir: this.workspaceDir,
      client: this.client,
      channelRegistry: this.channelRegistry,
      hitlPlugin: this.hitlPlugin,
      mailbox: this.mailbox,
      isExecutionActive: this.isExecutionActive,
      identityRegistry: new IdentityRegistry(this.workspaceDir),
      conversationManager: this.conversationManager,
      conversationTracer: this.conversationTracer,
    });
    this.ctx = ctx;

    // Apply moderation config
    const { rateLimit, spamPatterns } = config.moderation;
    ctx.rateMaxMessages = rateLimit.maxMessages;
    ctx.rateWindowMs = rateLimit.windowSeconds * 1_000;
    ctx.spamPatterns = compileSpamPatterns(spamPatterns);

    // Open persistent rate-limit store
    if (this.dataDir) openRateLimitDb(ctx, this.dataDir);

    // Setup DM accumulator
    setupDmAccumulator(ctx);

    // Register event handlers
    registerInboundHandlers(ctx);
    registerSlashCommandHandlers(ctx);
    registerOutboundHandlers(ctx);

    // ── Welcome new members ────────────────────────────────────────────────
    this.client.on(Events.GuildMemberAdd, async member => {
      const channelId = config.channels.welcome || process.env.DISCORD_WELCOME_CHANNEL;
      if (!channelId) return;
      const ch = member.guild.channels.cache.get(channelId) as TextChannel | undefined;
      await ch?.send(`Welcome to the protoLabs community, <@${member.id}>! 👋`).catch(() => {});
    });

    // ── Ready ──────────────────────────────────────────────────────────────
    this.client.once(Events.ClientReady, async c => {
      console.log(`[discord] Logged in as ${c.user.tag}`);
      await registerSlashCommands(ctx);
      warmDmChannels(ctx, c).catch(() => {});
    });

    // ── Hot-reload discord.yaml ────────────────────────────────────────────
    const configPath = join(this.workspaceDir, "discord.yaml");
    watchFile(configPath, { interval: 5_000 }, async () => {
      const prev = { commands: [...ctx.config.commands] };
      const newConfig = loadConfig(this.workspaceDir);
      Object.assign(ctx.config, newConfig);

      const { rateLimit: rl, spamPatterns: sp } = newConfig.moderation;
      ctx.rateMaxMessages = rl.maxMessages;
      ctx.rateWindowMs = rl.windowSeconds * 1_000;
      ctx.spamPatterns = compileSpamPatterns(sp);

      const prevCmds = JSON.stringify(prev.commands ?? []);
      const newCmds = JSON.stringify(newConfig.commands ?? []);
      if (prevCmds !== newCmds && this.client?.isReady()) {
        console.log("[discord] discord.yaml changed — re-registering slash commands");
        await registerSlashCommands(ctx).catch(console.error);
      } else {
        console.log("[discord] discord.yaml reloaded");
      }
    });

    // ── Login ──────────────────────────────────────────────────────────────
    this.client.login(process.env.DISCORD_BOT_TOKEN);

    // ── Agent client pool ──────────────────────────────────────────────────
    initAgentPool(ctx, (msg, agentName) => handleDM(ctx, msg, agentName));

    const agentsPath = join(this.workspaceDir, "agents.yaml");
    if (existsSync(agentsPath)) {
      watchFile(agentsPath, { interval: 5_000 }, () => {
        console.log("[discord] agents.yaml changed — reloading agent client pool");
        reloadAgentPool(ctx);
      });
    }
  }

  uninstall(): void {
    const ctx = this.ctx;
    if (ctx) {
      ctx.dmAccumulator?.destroy();
      ctx.pendingTurns.clear();
      ctx.pendingHITLMessages.clear();

      for (const [name, client] of ctx.agentClients) {
        client.destroy();
        console.log(`[discord] Destroyed agent client: ${name}`);
      }
      ctx.agentClients.clear();

      if (ctx.rlDb) {
        ctx.rlDb.close();
        ctx.rlDb = null;
      }
    }

    this.conversationManager.destroy();

    unwatchFile(join(this.workspaceDir, "discord.yaml"));
    unwatchFile(join(this.workspaceDir, "agents.yaml"));

    this.client?.destroy();
    this.ctx = null;
  }
}
