/**
 * discord/slash-commands.ts — /memory and future slash commands.
 *
 * Handles:
 *   InteractionCreate — autocomplete, HITL button presses, slash command dispatch
 */

import {
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import type { EventBus } from "../../types.ts";
import type { GraphitiClient } from "../../memory/graphiti-client.ts";
import type { IdentityRegistry } from "../../identity/identity-registry.ts";
import {
  loadProjectsDefs,
  isAdmin,
  makeId,
  interpolateContent,
  type DiscordConfig,
  type PendingReply,
} from "./core.ts";

export type HitlEntry = { message: Message; replyTopic: string };

export interface SlashContext {
  workspaceDir: string;
  getConfig: () => DiscordConfig;
  graphiti: GraphitiClient;
  identityRegistry: IdentityRegistry | null;
  pendingReplies: Map<string, PendingReply>;
  pendingAgents: Map<string, string>;
  pendingHITLMessages: Map<string, HitlEntry>;
}

async function handleMemoryCommand(
  interaction: ChatInputCommandInteraction,
  graphiti: GraphitiClient,
  identityRegistry: IdentityRegistry | null,
): Promise<void> {
  const userId = interaction.user.id;

  if (!identityRegistry) {
    await interaction.editReply("Memory not available.").catch(console.error);
    return;
  }

  const groupId = identityRegistry.groupId("discord", userId);
  const subName = interaction.options.getSubcommand(false);

  if (!subName || subName === "show") {
    const facts = await graphiti.search(groupId, "preferences habits goals context", 20).catch(() => []);
    if (facts.length === 0) {
      await interaction.editReply("No memory stored yet.").catch(console.error);
      return;
    }
    const now = Date.now();
    const active = facts.filter(f => {
      if (f.invalid_at && new Date(f.invalid_at).getTime() <= now) return false;
      if (f.expired_at && new Date(f.expired_at).getTime() <= now) return false;
      return true;
    });
    if (active.length === 0) {
      await interaction.editReply("No active memory facts.").catch(console.error);
      return;
    }
    const lines = active.map((f, i) => `**${i + 1}.** ${f.fact}`).join("\n");
    await interaction.editReply(`**Memory** (${active.length} facts):\n${lines}`.slice(0, 2000)).catch(console.error);

  } else if (subName === "search") {
    const query = interaction.options.getString("query", true);
    const facts = await graphiti.search(groupId, query, 10).catch(() => []);
    if (facts.length === 0) {
      await interaction.editReply(`No facts found for: "${query}"`).catch(console.error);
      return;
    }
    const lines = facts.map((f, i) => `**${i + 1}.** ${f.fact}`).join("\n");
    await interaction.editReply(`**"${query}"** — ${facts.length} fact(s):\n${lines}`.slice(0, 2000)).catch(console.error);

  } else if (subName === "clear") {
    await graphiti.clearUser(groupId);
    await interaction.editReply("Memory cleared.").catch(console.error);
  }
}

/**
 * Register the InteractionCreate handler on the main client.
 * Handles autocomplete, HITL button presses, and slash command dispatch.
 */
export function setupSlashCommandHandlers(
  client: Client,
  bus: EventBus,
  ctx: SlashContext,
): void {
  const { workspaceDir, getConfig, graphiti, identityRegistry,
    pendingReplies, pendingAgents, pendingHITLMessages } = ctx;

  client.on(Events.InteractionCreate, async interaction => {
    // ── Autocomplete: filter projects.yaml by typed value ──────────────────
    if (interaction.isAutocomplete()) {
      const cmdConfig = getConfig().commands.find(c => c.name === interaction.commandName);
      if (!cmdConfig) return;

      const focused = interaction.options.getFocused(true);
      if (focused.name === "project") {
        const projects = loadProjectsDefs(workspaceDir);
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

    // ── HITL button interactions ──────────────────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith("hitl:")) {
      const [, decision, correlationId] = interaction.customId.split(":");
      await interaction.deferUpdate();

      const entry = pendingHITLMessages.get(correlationId);
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

      if (entry) pendingHITLMessages.delete(correlationId);

      const COLOR_APPROVE = 0x22c55e;
      const COLOR_REJECT = 0xef4444;
      const COLOR_NEUTRAL = 0x6b7280;
      let color: number;
      if (decision === "approve") color = COLOR_APPROVE;
      else if (decision === "reject") color = COLOR_REJECT;
      else color = COLOR_NEUTRAL;
      const label = decision.charAt(0).toUpperCase() + decision.slice(1);
      const decidedEmbed = new EmbedBuilder()
        .setTitle(interaction.message.embeds[0]?.title ?? "Decision recorded")
        .setDescription(`**${label}** by <@${interaction.user.id}>`)
        .setColor(color);

      await interaction.message.edit({ embeds: [decidedEmbed], components: [] }).catch(console.error);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    // Pre-warm DM channel so subsequent DMs from this user are delivered via gateway
    client.users.createDM(interaction.user.id).catch(() => {});

    const cmdConfig = getConfig().commands.find(c => c.name === interaction.commandName);
    if (!cmdConfig) return;

    if (!isAdmin(interaction.user.id, getConfig().admins)) {
      console.log(`[discord] slash command from ${interaction.user.id} ignored — not in admins list`);
      await interaction.reply({ content: "Not authorised.", ephemeral: true }).catch(() => {});
      return;
    }

    // ── /memory — native handler (no bus dispatch) ──────────────────────────
    if (interaction.commandName === "memory") {
      await interaction.deferReply({ ephemeral: true });
      await handleMemoryCommand(interaction, graphiti, identityRegistry);
      return;
    }

    await interaction.deferReply();

    // ── Flat command (top-level options, no subcommands) ────────────────────
    const isFlatCommand = !!cmdConfig.options?.length && !cmdConfig.subcommands?.length;
    if (isFlatCommand) {
      // Resolve project metadata from projects.yaml if a `project` option is present
      const projectSlug = interaction.options.getString("project");
      let devChannelId: string | undefined;
      let projectRepo: string | undefined;

      if (projectSlug) {
        const projects = loadProjectsDefs(workspaceDir);
        const project = projects.find(p => p.slug === projectSlug);
        if (project) {
          devChannelId = project.discord?.dev || undefined;
          projectRepo = project.github || undefined;
        }
      }

      const content = interpolateContent(
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

    // ── Subcommand-based command (existing behaviour) ───────────────────────
    const subcommands = cmdConfig.subcommands ?? [];
    const subName = interaction.options.getSubcommand(false) ?? subcommands[0]?.name;
    const subConfig = subcommands.find(s => s.name === subName) ?? subcommands[0];

    if (!subConfig) {
      await interaction.editReply("Unknown subcommand.").catch(console.error);
      return;
    }

    // Interpolate {optionName} placeholders from config content template
    const content = interpolateContent(subConfig.content, subConfig.options ?? [], interaction);

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
}

