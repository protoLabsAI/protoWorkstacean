/**
 * DiscordPlugin — wires discord/* submodules into the Workstacean bus.
 * See discord/core.ts for config types, discord/inbound.ts for handlers, etc.
 */

import { watchFile, unwatchFile, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Events, type TextChannel } from "discord.js";
import type { EventBus, Plugin } from "../types.ts";
import type { ChannelRegistry } from "../channels/channel-registry.ts";
import type { HITLPlugin } from "./hitl.ts";
import { ConversationManager } from "../conversation/conversation-manager.ts";
import { ConversationTracer } from "../conversation/conversation-tracer.ts";
import { GraphitiClient } from "../memory/graphiti-client.ts";
import { IdentityRegistry } from "../identity/identity-registry.ts";
import {
  loadConfig, compileSpamPatterns, createMainClient, registerSlashCommands,
  type DiscordConfig, type PendingReply,
} from "./discord/core.ts";
import { createRateLimiter, type RateLimiter } from "./discord/rate-limit.ts";
import { createAgentPool, type AgentPool } from "./discord/agent-pool.ts";
import { warmDmChannels } from "./discord/dm-warming.ts";
import { handleDM, setupInboundHandlers } from "./discord/inbound.ts";
import { setupSlashCommandHandlers, type HitlEntry } from "./discord/slash-commands.ts";
import { setupOutboundSubscription, setupHITLRenderer } from "./discord/outbound.ts";

export class DiscordPlugin implements Plugin {
  readonly name = "discord";
  readonly description = "Discord gateway — routes messages to/from the A2A agent fleet";
  readonly capabilities = ["discord-inbound", "discord-outbound"];

  private client = createMainClient();
  private busRef!: EventBus;
  private config!: DiscordConfig;
  private workspaceDir: string;
  private dataDir: string | null;
  private agentPool!: AgentPool;
  private rateLimiter!: RateLimiter;
  private channelRegistry?: ChannelRegistry;
  private hitlPlugin?: HITLPlugin;
  private pendingReplies = new Map<string, PendingReply>();
  private pendingAgents = new Map<string, string>();
  private pendingHITLMessages = new Map<string, HitlEntry>();
  private pendingTurns = new Map<string, import("../conversation/conversation-tracer.ts").TurnData>();
  private conversationManager = new ConversationManager();
  private conversationTracer = new ConversationTracer();
  private graphiti = new GraphitiClient();
  private identityRegistry: IdentityRegistry | null = null;

  constructor(
    workspaceDir: string,
    dataDir?: string,
    channelRegistry?: ChannelRegistry,
    hitlPlugin?: HITLPlugin,
  ) {
    this.workspaceDir = workspaceDir;
    this.dataDir = dataDir ? resolve(dataDir) : null;
    this.channelRegistry = channelRegistry;
    this.hitlPlugin = hitlPlugin;
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
    this.identityRegistry = new IdentityRegistry(this.workspaceDir);

    const { rateLimit, spamPatterns } = this.config.moderation;
    this.rateLimiter = createRateLimiter({
      dataDir: this.dataDir,
      maxMessages: rateLimit.maxMessages,
      windowMs: rateLimit.windowSeconds * 1_000,
      spamPatterns: compileSpamPatterns(spamPatterns),
    });

    this.agentPool = createAgentPool({
      workspaceDir: this.workspaceDir,
      channelRegistry: this.channelRegistry,
      busRef: bus,
    });

    this.client.once(Events.ClientReady, async client => {
      console.log(`[discord] Logged in as ${client.user.tag}`);
      await registerSlashCommands(this.client, this.config);
      warmDmChannels(client, this.identityRegistry).catch(() => {});
    });

    const inboundCtx = {
      getConfig: () => this.config,
      rateLimiter: this.rateLimiter,
      conversationManager: this.conversationManager,
      conversationTracer: this.conversationTracer,
      pendingReplies: this.pendingReplies,
      pendingAgents: this.pendingAgents,
      pendingTurns: this.pendingTurns,
      channelRegistry: this.channelRegistry,
    };
    const dmHandler = (message: import("discord.js").Message, agentName: string | undefined, b: EventBus) =>
      handleDM(message, agentName, b, inboundCtx);

    setupInboundHandlers(this.client, bus, inboundCtx, dmHandler);

    setupSlashCommandHandlers(this.client, bus, {
      workspaceDir: this.workspaceDir,
      getConfig: () => this.config,
      graphiti: this.graphiti,
      identityRegistry: this.identityRegistry,
      pendingReplies: this.pendingReplies,
      pendingAgents: this.pendingAgents,
      pendingHITLMessages: this.pendingHITLMessages,
    });

    this.client.on(Events.GuildMemberAdd, async member => {
      const channelId = this.config.channels.welcome || process.env.DISCORD_WELCOME_CHANNEL;
      if (!channelId) return;
      const ch = member.guild.channels.cache.get(channelId) as TextChannel | undefined;
      await ch?.send(`Welcome to the protoLabs community, <@${member.id}>! 👋`).catch(() => {});
    });

    setupOutboundSubscription(bus, {
      client: this.client,
      agentPool: this.agentPool,
      pendingReplies: this.pendingReplies,
      pendingAgents: this.pendingAgents,
      pendingTurns: this.pendingTurns,
      conversationTracer: this.conversationTracer,
      getConfig: () => this.config,
    });

    setupHITLRenderer(this.hitlPlugin, this.client, bus, this.pendingHITLMessages);

    const configPath = join(this.workspaceDir, "discord.yaml");
    watchFile(configPath, { interval: 5_000 }, async () => {
      const prev = this.config;
      this.config = loadConfig(this.workspaceDir);
      const { rateLimit: rl, spamPatterns: sp } = this.config.moderation;
      this.rateLimiter.reconfigure(rl.maxMessages, rl.windowSeconds * 1_000, compileSpamPatterns(sp));
      const prevCmds = JSON.stringify(prev.commands ?? []);
      const newCmds = JSON.stringify(this.config.commands ?? []);
      if (prevCmds !== newCmds && this.client?.isReady()) {
        console.log("[discord] discord.yaml changed — re-registering slash commands");
        await registerSlashCommands(this.client, this.config).catch(console.error);
      } else {
        console.log("[discord] discord.yaml reloaded");
      }
    });

    this.client.login(process.env.DISCORD_BOT_TOKEN);
    this.agentPool.init(dmHandler);

    const agentsPath = join(this.workspaceDir, "agents.yaml");
    if (existsSync(agentsPath)) {
      watchFile(agentsPath, { interval: 5_000 }, () => {
        console.log("[discord] agents.yaml changed — reloading agent client pool");
        this.agentPool.reload();
      });
    }
  }

  uninstall(): void {
    this.conversationManager.destroy();
    this.pendingTurns.clear();
    this.pendingHITLMessages.clear();
    this.agentPool?.destroy();
    unwatchFile(join(this.workspaceDir, "discord.yaml"));
    unwatchFile(join(this.workspaceDir, "agents.yaml"));
    this.client?.destroy();
    this.rateLimiter?.close();
  }
}
