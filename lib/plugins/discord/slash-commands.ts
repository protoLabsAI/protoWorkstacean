/**
 * slash-commands.ts — Slash command registration and interaction handling.
 *
 * Handles: autocomplete, HITL button interactions, /memory command,
 * flat commands, and subcommand-based commands.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { Events, EmbedBuilder, type ChatInputCommandInteraction, type ButtonInteraction } from "discord.js";
import { channelIdOf, type ProjectDiscordChannel } from "../../project-schema.ts";
import { makeId, OPTION_TYPE_CODES } from "./core.ts";
import { pendingReplies } from "./outbound.ts";
import { handleMemoryCommand } from "./memory.ts";
import type { DiscordContext, CommandOption } from "./core.ts";

// ── Project types ─────────────────────────────────────────────────────────────

interface ProjectEntry {
  slug: string;
  title: string;
  github?: string;
  status?: string;
  discord?: {
    general?: ProjectDiscordChannel;
    updates?: ProjectDiscordChannel;
    dev?: ProjectDiscordChannel;
  };
}

interface ProjectsYaml {
  projects: ProjectEntry[];
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

// ── Content interpolation ─────────────────────────────────────────────────────

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

// ── HITL button interaction ───────────────────────────────────────────────────

async function handleHITLButton(ctx: DiscordContext, interaction: ButtonInteraction): Promise<void> {
  try { await interaction.deferUpdate(); } catch (err) {
    console.warn(`[discord] HITL deferUpdate failed (${err instanceof Error ? err.message : err}) — processing decision anyway`);
  }

  const [, decision, correlationId] = interaction.customId.split(":");
  if (!decision || !correlationId) {
    console.warn(`[discord] HITL button with malformed customId: ${interaction.customId}`);
    return;
  }

  const entry = ctx.pendingHITLMessages.get(correlationId);
  const replyTopic = entry?.replyTopic ?? `hitl.response.pr.remediation_stuck.${correlationId}`;

  try {
    ctx.bus.publish(replyTopic, {
      id: crypto.randomUUID(), correlationId, topic: replyTopic, timestamp: Date.now(),
      payload: { type: "hitl_response", correlationId, decision, decidedBy: interaction.user.id },
    });
  } catch (err) {
    console.error(`[discord] HITL bus publish failed for ${correlationId}:`, err);
  }

  if (entry) ctx.pendingHITLMessages.delete(correlationId);

  const COLOR_MAP: Record<string, number> = { approve: 0x22c55e, reject: 0xef4444 };
  const color = COLOR_MAP[decision] ?? 0x6b7280;
  const label = decision.charAt(0).toUpperCase() + decision.slice(1).replace(/_/g, " ");
  const decidedEmbed = new EmbedBuilder()
    .setTitle(interaction.message.embeds[0]?.title ?? "Decision recorded")
    .setDescription(`**${label}** by <@${interaction.user.id}>`)
    .setColor(color);

  await interaction.message.edit({ embeds: [decidedEmbed], components: [] }).catch(err => {
    console.warn(`[discord] HITL message edit failed for ${correlationId}:`, err instanceof Error ? err.message : err);
  });
}

// ── Slash command registration ────────────────────────────────────────────────

export async function registerSlashCommands(ctx: DiscordContext): Promise<void> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) { console.log("[discord] DISCORD_GUILD_ID not set — skipping slash command registration"); return; }

  const guild = ctx.client.guilds.cache.get(guildId);
  if (!guild) { console.log(`[discord] Guild ${guildId} not found`); return; }
  if (!ctx.config.commands.length) { console.log("[discord] No commands configured in discord.yaml"); return; }

  const commandData = ctx.config.commands.map(cmd => {
    if (cmd.options?.length && !cmd.subcommands?.length) {
      return {
        name: cmd.name, description: cmd.description,
        options: cmd.options.map(opt => ({
          name: opt.name, description: opt.description,
          type: OPTION_TYPE_CODES[opt.type] ?? 3, required: opt.required ?? false, autocomplete: opt.autocomplete ?? false,
        })),
      };
    }
    return {
      name: cmd.name, description: cmd.description,
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

// ── Register interaction handlers ─────────────────────────────────────────────

export function registerSlashCommandHandlers(ctx: DiscordContext): void {
  ctx.client.on(Events.InteractionCreate, async interaction => {
    if (interaction.isAutocomplete()) {
      const cmdConfig = ctx.config.commands.find(c => c.name === interaction.commandName);
      if (!cmdConfig) return;
      const focused = interaction.options.getFocused(true);
      if (focused.name === "project") {
        const projects = loadProjectsDefs(ctx.workspaceDir);
        const typed = focused.value.toLowerCase();
        const choices = projects
          .filter(p => p.slug.toLowerCase().includes(typed) || p.title.toLowerCase().includes(typed))
          .slice(0, 25).map(p => ({ name: p.title, value: p.slug }));
        await interaction.respond(choices).catch(console.error);
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith("hitl:")) {
      await handleHITLButton(ctx, interaction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;
    ctx.client.users.createDM(interaction.user.id).catch(() => {});

    const cmdConfig = ctx.config.commands.find(c => c.name === interaction.commandName);
    if (!cmdConfig) return;

    if (ctx.config.admins?.length && !ctx.config.admins.includes(interaction.user.id)) {
      console.log(`[discord] slash command from ${interaction.user.id} ignored — not in admins list`);
      await interaction.reply({ content: "Not authorised.", ephemeral: true }).catch(() => {});
      return;
    }

    if (interaction.commandName === "memory") {
      await interaction.deferReply({ ephemeral: true });
      await handleMemoryCommand(ctx, interaction);
      return;
    }

    await interaction.deferReply();

    const isFlatCommand = !!cmdConfig.options?.length && !cmdConfig.subcommands?.length;
    if (isFlatCommand) {
      const projectSlug = interaction.options.getString("project");
      let devChannelId: string | undefined;
      let projectRepo: string | undefined;
      if (projectSlug) {
        const project = loadProjectsDefs(ctx.workspaceDir).find(p => p.slug === projectSlug);
        if (project) {
          devChannelId = channelIdOf(project.discord?.dev) || undefined;
          projectRepo = project.github || undefined;
        }
      }
      const content = interpolateContent(cmdConfig.content ?? "", cmdConfig.options ?? [], interaction);
      const correlationId = makeId();
      pendingReplies.set(correlationId, { interaction });
      const topicSuffix = `slash.${interaction.id}`;
      ctx.bus.publish(`message.inbound.discord.${topicSuffix}`, {
        id: interaction.id, correlationId, topic: `message.inbound.discord.${topicSuffix}`, timestamp: Date.now(),
        payload: { sender: interaction.user.id, channel: interaction.channelId, content, skillHint: cmdConfig.skillHint,
          ...(devChannelId ? { devChannelId } : {}), ...(projectRepo ? { projectRepo } : {}) },
        source: { interface: "discord" as const, channelId: interaction.channelId, userId: interaction.user.id },
        reply: { topic: `message.outbound.discord.${topicSuffix}` },
      });
      return;
    }

    const subcommands = cmdConfig.subcommands ?? [];
    const subName = interaction.options.getSubcommand(false) ?? subcommands[0]?.name;
    const subConfig = subcommands.find(s => s.name === subName) ?? subcommands[0];
    if (!subConfig) { await interaction.editReply("Unknown subcommand.").catch(console.error); return; }

    const content = interpolateContent(subConfig.content, subConfig.options ?? [], interaction);
    const correlationId = makeId();
    pendingReplies.set(correlationId, { interaction });
    const topicSuffix = `slash.${interaction.id}`;
    ctx.bus.publish(`message.inbound.discord.${topicSuffix}`, {
      id: interaction.id, correlationId, topic: `message.inbound.discord.${topicSuffix}`, timestamp: Date.now(),
      payload: { sender: interaction.user.id, channel: interaction.channelId, content, skillHint: subConfig.skillHint },
      source: { interface: "discord" as const, channelId: interaction.channelId, userId: interaction.user.id },
      reply: { topic: `message.outbound.discord.${topicSuffix}` },
    });
  });
}
