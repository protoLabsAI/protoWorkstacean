/**
 * slash-commands.ts — Slash command registration and interaction handling.
 *
 * Handles: autocomplete, HITL button interactions, /memory command,
 * flat commands, and subcommand-based commands.
 *
 * Project autocomplete + project-scoped command payloads read from
 * the in-process ProtomakerProjectRegistry and ChannelRegistry.
 */

import { Events, type ChatInputCommandInteraction } from "discord.js";
import { makeId, OPTION_TYPE_CODES } from "./core.ts";
import { pendingReplies } from "./outbound.ts";
import type { DiscordContext, CommandOption } from "./core.ts";

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
        const projects = ctx.projectRegistry?.getProjects() ?? [];
        const typed = focused.value.toLowerCase();
        const choices = projects
          .filter(p => p.slug.toLowerCase().includes(typed) || p.name.toLowerCase().includes(typed))
          .slice(0, 25).map(p => ({ name: p.name, value: p.slug }));
        await interaction.respond(choices).catch(console.error);
      }
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

    await interaction.deferReply();

    const isFlatCommand = !!cmdConfig.options?.length && !cmdConfig.subcommands?.length;
    if (isFlatCommand) {
      const projectSlug = interaction.options.getString("project");
      let devChannelId: string | undefined;
      let projectRepo: string | undefined;
      if (projectSlug) {
        const project = ctx.projectRegistry?.getBySlug(projectSlug);
        if (project) {
          devChannelId = ctx.channelRegistry?.getProjectChannel(projectSlug, "dev")?.channelId || undefined;
          projectRepo = project.github ? `${project.github.owner}/${project.github.repo}` : undefined;
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
