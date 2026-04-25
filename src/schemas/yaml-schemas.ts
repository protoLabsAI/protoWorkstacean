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
});

export type AgentDefinitionInput = z.input<typeof AgentDefinitionSchema>;
export type AgentDefinitionOutput = z.output<typeof AgentDefinitionSchema>;

// ── workspace/goals.yaml ─────────────────────────────────────────────────────

export const SeveritySchema = z.enum(["low", "medium", "high", "critical"]);

export const InvariantOperatorSchema = z.enum([
  "eq",
  "neq",
  "truthy",
  "falsy",
  "in",
  "not_in",
]);

const BaseGoalSchema = z.object({
  id: z.string().min(1, "Goal id must not be empty"),
  description: z.string().min(1, "Goal description must not be empty"),
  severity: SeveritySchema.optional(),
  enabled: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

export const InvariantGoalSchema = BaseGoalSchema.extend({
  type: z.literal("Invariant"),
  selector: z.string().min(1),
  expected: z.unknown().optional(),
  operator: InvariantOperatorSchema.optional(),
});

export const ThresholdGoalSchema = BaseGoalSchema.extend({
  type: z.literal("Threshold"),
  selector: z.string().min(1),
  min: z.number().optional(),
  max: z.number().optional(),
});

export const DistributionGoalSchema = BaseGoalSchema.extend({
  type: z.literal("Distribution"),
  selector: z.string().min(1),
  pattern: z.string().optional(),
  distribution: z.record(z.number()).optional(),
  tolerance: z.number().min(0).max(1).optional(),
});

export const GoalSchema = z.discriminatedUnion("type", [
  InvariantGoalSchema,
  ThresholdGoalSchema,
  DistributionGoalSchema,
]);

export const GoalsFileSchema = z.object({
  version: z.string().optional(),
  goals: z.array(GoalSchema),
});

export type GoalInput = z.input<typeof GoalSchema>;

// ── workspace/actions.yaml ───────────────────────────────────────────────────

export const ConditionOperatorSchema = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "exists",
  "not_exists",
]);

export const PreconditionSchema = z.object({
  path: z.string().min(1, "Precondition path must not be empty"),
  operator: ConditionOperatorSchema,
  value: z.unknown().optional(),
});

export const EffectOperationSchema = z.enum([
  "set",
  "increment",
  "decrement",
  "delete",
]);

export const EffectSchema = z.object({
  path: z.string().min(1, "Effect path must not be empty"),
  operation: EffectOperationSchema,
  value: z.unknown().optional(),
});

export const ActionMetaSchema = z.object({
  agentId: z.string().optional(),
  timeout: z.number().optional(),
  context: z.record(z.unknown()).optional(),
  fireAndForget: z.boolean().optional(),
  skillHint: z.string().optional(),
  /** Per-action cooldown enforced by ActionDispatcherPlugin. */
  cooldownMs: z.number().int().nonnegative().optional(),
});

export const ActionTierSchema = z.enum(["tier_0", "tier_1", "tier_2"]);

export const ActionSchema = z.object({
  id: z.string().min(1, "Action id must not be empty"),
  name: z.string().min(1, "Action name must not be empty"),
  description: z.string().default(""),
  goalId: z.string().min(1, "Action goalId must not be empty"),
  tier: ActionTierSchema,
  preconditions: z.array(PreconditionSchema).default([]),
  effects: z.array(EffectSchema).default([]),
  cost: z.number().default(0),
  priority: z.number().default(0),
  meta: ActionMetaSchema.default({}),
});

export const ActionsFileSchema = z.object({
  actions: z.array(ActionSchema),
});

export type ActionInput = z.input<typeof ActionSchema>;
export type ActionOutput = z.output<typeof ActionSchema>;

// ── workspace/ceremonies/*.yaml ──────────────────────────────────────────────

export const CeremonySchema = z.object({
  id: z.string().min(1, "Ceremony id must not be empty"),
  name: z.string().min(1, "Ceremony name must not be empty"),
  schedule: z.string().min(1, "Ceremony schedule must not be empty"),
  skill: z.string().min(1, "Ceremony skill must not be empty"),
  targets: z.array(z.string()).min(1, "Ceremony targets must be a non-empty array"),
  notifyChannel: z.string().optional(),
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
  // Discord-specific
  channelId: z.string().optional(),
  guildId: z.string().optional(),
  // GitHub-specific
  repo: z.string().optional(),
  // Signal-specific
  groupId: z.string().optional(),
  // Slack-specific
  slackChannelId: z.string().optional(),
  conversation: ConversationConfigSchema.optional(),
});

export const ChannelsFileSchema = z.object({
  channels: z.array(ChannelSchema),
});

export type ChannelInput = z.input<typeof ChannelSchema>;

// ── workspace/projects.yaml ──────────────────────────────────────────────────

const ProjectDiscordChannelsSchema = z.object({
  general: z.string().optional(),
  updates: z.string().optional(),
  dev: z.string().optional(),
  alerts: z.string().optional(),
  releases: z.string().optional(),
});

export const ProjectSchema = z.object({
  slug: z.string().min(1, "Project slug must not be empty"),
  title: z.string().optional(),
  github: z.string().regex(/^[^/]+\/[^/]+$/, "github must be 'owner/repo' format"),
  defaultBranch: z.string().default("main"),
  status: z.enum(["active", "inactive", "archived", "suspended"]).default("active"),
  agents: z.array(z.string()).optional(),
  discord: z.union([
    ProjectDiscordChannelsSchema,
    z.object({ channels: ProjectDiscordChannelsSchema }),
  ]).optional(),
});

export const ProjectsFileSchema = z.object({
  projects: z.array(ProjectSchema),
});

export type ProjectInput = z.input<typeof ProjectSchema>;
export type ProjectOutput = z.output<typeof ProjectSchema>;
