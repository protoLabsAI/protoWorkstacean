/**
 * Channel type definitions — workspace/channels.yaml schema.
 *
 * A channel is a named, platform-specific communication endpoint that routes
 * inbound messages to a specific agent. One channels.yaml entry = one routing
 * rule: "messages from this Discord channel/GitHub repo/Signal group go to
 * this agent, using this identity."
 */

export type ChannelPlatform = "discord" | "github" | "signal" | "slack" | "plane";

/**
 * Per-channel conversation settings (Discord only for now).
 *
 * When enabled, the channel maintains a stateful session per user. Messages
 * from the same user in the same channel share a stable correlationId, which
 * the A2A layer uses as the conversation contextId — giving agents full
 * multi-turn memory.
 */
export interface ConversationConfig {
  /** Enable multi-turn conversation mode. Default: false. */
  enabled?: boolean;

  /**
   * Inactivity timeout in milliseconds before the session expires.
   * A new @mention starts a fresh conversation after expiry.
   * Default: 300000 (5 minutes).
   */
  timeoutMs?: number;

  /**
   * When false (default), the user can continue chatting without re-mentioning
   * the bot once a conversation is active. Set to true to require @mention
   * on every message.
   */
  requireMentionAfterFirst?: boolean;
}

export interface Channel {
  /** Unique identifier for this channel definition (used in logs and API responses). */
  id: string;

  /** Target platform. */
  platform: ChannelPlatform;

  /** Human-readable description — surfaced in /api/channels and docs. */
  description?: string;

  /**
   * Agent name to route messages from this channel to.
   * Must match a name in workspace/agents/*.yaml or workspace/agents.yaml.
   */
  agent?: string;

  /** Set false to disable this channel without removing the entry. Default: true. */
  enabled?: boolean;

  /**
   * Multi-turn conversation settings.
   * When configured, the channel maintains a stateful session per user.
   */
  conversation?: ConversationConfig;

  // ── Discord ──────────────────────────────────────────────────────────────────

  /**
   * Discord channel ID (or thread ID) this entry applies to.
   * Required for platform: discord.
   */
  channelId?: string;

  /**
   * Environment variable name holding the Discord bot token for this agent.
   * When set, the agent responds from its own Discord identity (its own bot).
   * Falls back to DISCORD_BOT_TOKEN if unset.
   *
   * Example: agentBotTokenEnv: QUINN_DISCORD_TOKEN
   *          → reads process.env.QUINN_DISCORD_TOKEN at startup
   */
  agentBotTokenEnv?: string;

  /** Discord guild (server) ID — used to scope slash command registration. */
  guildId?: string;

  // ── GitHub ───────────────────────────────────────────────────────────────────

  /**
   * GitHub repository in "owner/repo" format.
   * Required for platform: github.
   */
  repo?: string;

  // ── Signal ───────────────────────────────────────────────────────────────────

  /**
   * Signal group ID or phone number this channel listens on.
   * Required for platform: signal.
   */
  groupId?: string;

  // ── Slack ────────────────────────────────────────────────────────────────────

  /**
   * Slack channel ID (e.g. C1234567890).
   * Required for platform: slack.
   */
  slackChannelId?: string;

  /**
   * Environment variable name holding the Slack bot OAuth token.
   * Example: agentSlackTokenEnv: QUINN_SLACK_TOKEN
   */
  agentSlackTokenEnv?: string;
}

export interface ChannelsYaml {
  channels?: Channel[];
}
