/**
 * project-schema.ts — Zod schema for workspace/projects.yaml entries.
 *
 * Required fields: slug, github, status, discord.dev
 * Optional: all other fields including onboarding state tracking per project.
 *
 * Used by:
 *   - lib/plugins/a2a.ts   — validates on load (warns + skips invalid entries)
 *   - lib/plugins/onboarding.ts — validates on write (fails step if invalid)
 */

import { z } from "zod";

// ── Sub-schemas ───────────────────────────────────────────────────────────────

export const GoogleWorkspaceSchema = z.object({
  /** Per-project Drive folder ID (created by OnboardingPlugin step 9). */
  driveFolderId: z.string().optional(),
  /** Project spec/brief Google Doc ID. */
  sharedDocId: z.string().optional(),
  /** Project-scoped calendar ID (if needed). */
  calendarId: z.string().optional(),
}).optional();

export type GoogleWorkspace = z.infer<typeof GoogleWorkspaceSchema>;

/**
 * A single Discord channel entry. Supports the legacy flat-string form
 * (just a channelId) and the new object form that carries both channelId
 * and an optional per-channel webhook URL for high-throughput paths
 * that don't go through the bot.
 */
export const ProjectDiscordChannelSchema = z.union([
  z.string(),
  z.object({
    channelId: z.string(),
    webhook: z.string().optional(),
  }),
]);

export type ProjectDiscordChannel = z.infer<typeof ProjectDiscordChannelSchema>;

/** Extract a channelId regardless of whether the field is string or object. */
export function channelIdOf(channel: ProjectDiscordChannel | undefined): string {
  if (!channel) return "";
  if (typeof channel === "string") return channel;
  return channel.channelId;
}

export const ProjectDiscordSchema = z.object({
  general: ProjectDiscordChannelSchema.optional(),
  updates: ProjectDiscordChannelSchema.optional(),
  dev: ProjectDiscordChannelSchema,  // required — may be empty string until channel is created
  alerts: ProjectDiscordChannelSchema.optional(),
  releases: ProjectDiscordChannelSchema.optional(),
  release: ProjectDiscordChannelSchema.optional(),
});

export const OnboardingStateSchema = z.object({
  githubWebhook: z.enum(["ok", "skip", "error"]).optional(),
  projectsYaml: z.enum(["ok", "skip", "error"]).optional(),
}).optional();

// ── Main project entry schema ─────────────────────────────────────────────────

export const ProjectEntrySchema = z.object({
  slug:          z.string().min(1),
  title:         z.string().optional(),
  github:        z.string().regex(/^[^/]+\/[^/]+$/, 'Must be "owner/repo" format'),
  status:        z.string().min(1),
  defaultBranch: z.string().optional(),
  team:          z.string().optional(),
  agents:        z.array(z.string()).optional(),
  discord:       ProjectDiscordSchema,
  onboardedAt:   z.string().optional(),
  /** Optional per-project onboarding step tracking */
  onboardingState: OnboardingStateSchema,
  /** Google Workspace resources for this project */
  googleWorkspace: GoogleWorkspaceSchema,
});

export type ProjectEntry = z.infer<typeof ProjectEntrySchema>;
export type ProjectDiscord = z.infer<typeof ProjectDiscordSchema>;

// ── Top-level YAML schema ─────────────────────────────────────────────────────

export const ProjectsYamlSchema = z.object({
  projects: z.array(ProjectEntrySchema),
});

export type ProjectsYaml = z.infer<typeof ProjectsYamlSchema>;

// ── Validation helpers ────────────────────────────────────────────────────────

/**
 * Validate a single raw project entry from projects.yaml.
 * Returns the parsed entry on success, or a list of error messages on failure.
 */
export function validateProjectEntry(
  raw: unknown,
): { ok: true; entry: ProjectEntry } | { ok: false; errors: string[] } {
  const result = ProjectEntrySchema.safeParse(raw);
  if (result.success) {
    return { ok: true, entry: result.data };
  }
  const errors = result.error.issues.map(
    issue => `${issue.path.join(".")}: ${issue.message}`,
  );
  return { ok: false, errors };
}

/**
 * Validate the full projects.yaml structure.
 * Returns validated data or throws with a descriptive message.
 */
export function parseProjectsYaml(raw: unknown): ProjectsYaml {
  return ProjectsYamlSchema.parse(raw);
}
