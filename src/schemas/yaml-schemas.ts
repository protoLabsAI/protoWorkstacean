/**
 * Zod schemas for all workspace YAML files.
 *
 * Use these at API/loader boundaries for runtime validation with descriptive
 * error messages, replacing manual `as Record<string, unknown>` coercions.
 *
 * Each schema matches the corresponding TypeScript interface while providing
 * parse-time validation so bad config surfaces at startup, not silently later.
 */

import { z } from "zod";

// ── workspace/agents/*.yaml ──────────────────────────────────────────────────

export const AgentRoleSchema = z.enum([
  "orchestrator",
  "qa",
  "devops",
  "content",
  "research",
  "general",
]);

export const AgentSkillDefinitionSchema = z.object({
  name: z.string().min(1, "Skill name must not be empty"),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  systemPromptOverride: z.string().optional(),
});

export const AgentDefinitionSchema = z.object({
  name: z.string().min(1, "Agent name must not be empty"),
  role: AgentRoleSchema,
  model: z.string().min(1, "Model must not be empty"),
  systemPrompt: z.string().min(1, "systemPrompt must not be empty"),
  tools: z.array(z.string()).default([]),
  allowedTools: z.array(z.string()).optional(),
  excludeTools: z.array(z.string()).optional(),
  canDelegate: z.array(z.string()).optional(),
  maxTurns: z.number().int().refine(
    (n) => n === -1 || n > 0,
    "maxTurns must be -1 (unlimited) or a positive integer",
  ).default(10),
  skills: z.array(AgentSkillDefinitionSchema).default([]),
  memory: z
    .object({
      enabled: z.boolean(),
      skills: z.array(z.string()).optional(),
      historyTurns: z.number().int().positive().optional(),
      recallTopK: z.number().int().positive().optional(),
      harvest: z.boolean().optional(),
    })
    .optional(),
});

export type AgentDefinitionInput = z.input<typeof AgentDefinitionSchema>;
export type AgentDefinitionOutput = z.output<typeof AgentDefinitionSchema>;

// ── workspace/ceremonies/*.yaml ──────────────────────────────────────────────

export const CeremonySchema = z.object({
  id: z.string().min(1, "Ceremony id must not be empty"),
  name: z.string().min(1, "Ceremony name must not be empty"),
  schedule: z.string().min(1, "Ceremony schedule must not be empty"),
  skill: z.string().min(1, "Ceremony skill must not be empty"),
  targets: z.array(z.string()).min(1, "Ceremony targets must be a non-empty array"),
  notifyChannel: z.string().optional(),
  notifyWebhookEnv: z.string().optional(),
  enabled: z.boolean().default(true),
});

export type CeremonyInput = z.input<typeof CeremonySchema>;

// ── workspace/channels.yaml ──────────────────────────────────────────────────

export const ChannelPlatformSchema = z.enum([
  "discord",
  "github",
  "signal",
  "slack",
  "linear",
  "google",
]);

export const ConversationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  timeoutSeconds: z.number().optional(),
  requireMentionAfterFirst: z.boolean().optional(),
});

export const ChannelSchema = z.object({
  id: z.string().min(1),
  platform: ChannelPlatformSchema,
  agent: z.string().optional(),
  enabled: z.boolean().optional(),
  description: z.string().optional(),
  // Project binding (optional; both project + kind required for it to index).
  project: z.string().optional(),
  kind: z.string().optional(),
  webhook: z.string().optional(),
  // Discord-specific
  channelId: z.string().optional(),
  guildId: z.string().optional(),
  agentBotTokenEnv: z.string().optional(),
  // GitHub-specific
  repo: z.string().optional(),
  // Signal-specific
  groupId: z.string().optional(),
  // Slack-specific
  slackChannelId: z.string().optional(),
  agentSlackTokenEnv: z.string().optional(),
  conversation: ConversationConfigSchema.optional(),
});

export const ChannelsFileSchema = z.object({
  channels: z.array(ChannelSchema),
});

export type ChannelInput = z.input<typeof ChannelSchema>;
