/**
 * core.ts — Discord client factory, config types, and shared context interface.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Database } from "bun:sqlite";
import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { EventBus } from "../../types.ts";
import type { HITLPlugin } from "../hitl.ts";
import type { ConfigChangeHITLPlugin } from "../config-change-hitl.ts";
import type { ChannelRegistry } from "../../channels/channel-registry.ts";
import { ConversationManager } from "../../conversation/conversation-manager.ts";
import { ConversationTracer, type TurnData } from "../../conversation/conversation-tracer.ts";
import { GraphitiClient } from "../../memory/graphiti-client.ts";
import { IdentityRegistry } from "../../identity/identity-registry.ts";
import type { DmAccumulator } from "../../dm/dm-accumulator.ts";
import type { ContextMailbox } from "../../dm/context-mailbox.ts";

// ── Config types ──────────────────────────────────────────────────────────────

export interface CommandOption {
  name: string;
  description: string;
  type: "string" | "integer" | "boolean";
  required?: boolean;
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
  subcommands?: Subcommand[];
  options?: CommandOption[];
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

// ── Discord option type codes ─────────────────────────────────────────────────

export const OPTION_TYPE_CODES: Record<string, number> = {
  string: 3,
  integer: 4,
  boolean: 5,
};

// ── Shared utilities ──────────────────────────────────────────────────────────

export function makeId(): string {
  return crypto.randomUUID();
}

// ── Shared context interface ──────────────────────────────────────────────────

export interface DiscordContext {
  bus: EventBus;
  config: DiscordConfig;
  workspaceDir: string;
  client: Client;
  agentClients: Map<string, Client>;
  pendingAgents: Map<string, string>;
  channelRegistry?: ChannelRegistry;
  hitlPlugin?: HITLPlugin;
  configChangePlugin?: ConfigChangeHITLPlugin;
  mailbox?: ContextMailbox;
  isExecutionActive?: (correlationId: string) => boolean;
  pendingHITLMessages: Map<string, { message: Message; replyTopic: string }>;
  pendingConfigChangeMessages: Map<string, { message: Message; replyTopic: string }>;
  conversationManager: ConversationManager;
  conversationTracer: ConversationTracer;
  graphiti: GraphitiClient;
  identityRegistry: IdentityRegistry | null;
  pendingTurns: Map<string, TurnData>;
  dmAccumulator?: DmAccumulator;
  // Rate limit state
  rateLimits: Map<string, number[]>;
  rateMaxMessages: number;
  rateWindowMs: number;
  spamPatterns: RegExp[];
  rlDb: Database | null;
}

// ── Client factory ────────────────────────────────────────────────────────────

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

export function createAgentClient(): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });
}

// ── Context factory ───────────────────────────────────────────────────────────

export function buildContext(opts: {
  bus: EventBus;
  config: DiscordConfig;
  workspaceDir: string;
  client: Client;
  channelRegistry?: ChannelRegistry;
  hitlPlugin?: HITLPlugin;
  configChangePlugin?: ConfigChangeHITLPlugin;
  mailbox?: ContextMailbox;
  isExecutionActive?: (correlationId: string) => boolean;
  identityRegistry: IdentityRegistry | null;
  conversationManager: ConversationManager;
  conversationTracer: ConversationTracer;
}): DiscordContext {
  return {
    bus: opts.bus,
    config: opts.config,
    workspaceDir: opts.workspaceDir,
    client: opts.client,
    agentClients: new Map(),
    pendingAgents: new Map(),
    channelRegistry: opts.channelRegistry,
    hitlPlugin: opts.hitlPlugin,
    configChangePlugin: opts.configChangePlugin,
    mailbox: opts.mailbox,
    isExecutionActive: opts.isExecutionActive,
    pendingHITLMessages: new Map(),
    pendingConfigChangeMessages: new Map(),
    conversationManager: opts.conversationManager,
    conversationTracer: opts.conversationTracer,
    graphiti: new GraphitiClient(),
    identityRegistry: opts.identityRegistry,
    pendingTurns: new Map(),
    dmAccumulator: undefined,
    rateLimits: new Map(),
    rateMaxMessages: 5,
    rateWindowMs: 10_000,
    spamPatterns: [],
    rlDb: null,
  };
}

export type { Message, ChatInputCommandInteraction, TurnData };
