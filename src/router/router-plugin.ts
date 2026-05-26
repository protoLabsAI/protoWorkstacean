/**
 * RouterPlugin — routes inbound messages to agents via agent.skill.request.
 *
 * Subscribes to:
 *   message.inbound.#  — from Discord, GitHub, Linear, Google, HTTP API
 *   cron.#             — from SchedulerPlugin
 *
 * Publishes:
 *   agent.skill.request  — with skill, content, projectSlug, and reply.topic
 *
 * Skill resolution order:
 *   1. payload.skillHint  — explicit, set by surface plugins
 *   2. keyword match      — configured in workspace/agents/*.yaml skills[].keywords
 *   3. ROUTER_DEFAULT_SKILL env var — optional catch-all (e.g. "sitrep")
 *
 * GitHub enrichment: for inbound github messages, the router looks up the
 * repo in the ProtomakerProjectRegistry and stamps `projectSlug` +
 * per-project Discord channel IDs (from ChannelRegistry) onto the
 * dispatched payload so downstream skills can address project context.
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { InboundMessagePayload, CronPayload } from "../event-bus/payloads.ts";
import { SkillResolver } from "./skill-resolver.ts";
import { loadAgentDefinitions } from "../agent-runtime/agent-definition-loader.ts";
import type { ChannelRegistry } from "../../lib/channels/channel-registry.ts";
import type { ProtomakerProjectRegistryPlugin } from "../plugins/protomaker-project-registry-plugin.ts";
import { TTLCache } from "../../lib/ttl-cache.ts";
import { TOPICS } from "../event-bus/topics.ts";

export interface RouterConfig {
  workspaceDir: string;
  /** Fallback skill when no hint or keyword matches. Default: ROUTER_DEFAULT_SKILL env var. */
  defaultSkill?: string;
  /**
   * Optional channel registry. When provided, inbound messages from a channel
   * with an explicit agent assignment are routed directly to that agent without
   * requiring a keyword match. Also used to resolve per-project Discord channel
   * IDs during GitHub message enrichment.
   */
  channelRegistry?: ChannelRegistry;
  /**
   * Source of truth for project metadata. When provided, inbound GitHub
   * messages are stamped with `projectSlug` resolved by `owner/repo`.
   */
  projectRegistry?: ProtomakerProjectRegistryPlugin;
}

function extractLinearEvent(topic: string): string | undefined {
  const prefix = "message.inbound.linear.";
  if (!topic.startsWith(prefix)) return undefined;
  const rest = topic.slice(prefix.length);
  return rest || undefined;
}

/** Build reply topic from channel + optional recipient. */
function buildReplyTopic(channel: string, recipient?: string): string {
  if (channel === "signal") {
    return recipient ? `message.outbound.signal.${recipient}` : "message.outbound.signal.cron";
  }
  return `message.outbound.${channel}`;
}

export class RouterPlugin implements Plugin {
  readonly name = "router";
  readonly description =
    "Routes message.inbound.# and cron.# to agents via agent.skill.request";
  readonly capabilities = ["message-routing", "skill-dispatch", "github-enrichment"];
  readonly subscribes = ["message.inbound.#", "cron.#"];
  readonly publishes = ["agent.skill.request"];

  private bus?: EventBus;
  private readonly resolver: SkillResolver;
  private readonly subscriptionIds: string[] = [];
  private readonly config: RouterConfig;

  /**
   * DM conversation stickiness: once a skill/agent is matched for a DM
   * conversation, subsequent turns reuse the same target without re-running
   * keyword matching. TTL slides on every turn (default: DM_CONVERSATION_TIMEOUT_MS).
   */
  private readonly dmSessions: TTLCache<{ agentName: string; skill: string }>;

  constructor(config: RouterConfig) {
    this.config = config;
    const defaultSkill =
      config.defaultSkill ?? process.env.ROUTER_DEFAULT_SKILL;
    this.resolver = new SkillResolver(defaultSkill);

    const dmTimeoutSec = Math.round(
      Number(process.env.DM_CONVERSATION_TIMEOUT_MS ?? 15 * 60_000) / 1000,
    );
    this.dmSessions = new TTLCache(dmTimeoutSec);
  }

  install(bus: EventBus): void {
    this.bus = bus;

    // Load skill keyword map from agent definitions
    this._reloadSkills();

    // Subscribe to inbound messages from all surfaces
    this.subscriptionIds.push(
      bus.subscribe(TOPICS.MESSAGE_INBOUND_ALL, this.name, (msg) => {
        void this._handleInbound(msg);
      }),
    );

    // Subscribe to cron events from SchedulerPlugin
    this.subscriptionIds.push(
      bus.subscribe(TOPICS.CRON_ALL, this.name, (msg) => {
        void this._handleCron(msg);
      }),
    );

    console.log(
      `[router] Plugin installed — ${this.resolver.size} skill keyword entry/entries`,
    );
  }

  uninstall(): void {
    if (this.bus) {
      for (const id of this.subscriptionIds) this.bus.unsubscribe(id);
    }
    this.subscriptionIds.length = 0;
    this.bus = undefined;
  }

  private _reloadSkills(): void {
    const defs = loadAgentDefinitions(this.config.workspaceDir);
    this.resolver.loadFromAgents(defs);
  }

  /**
   * Stamp `projectSlug` + per-project Discord channel IDs onto an inbound
   * GitHub message payload. Returns the original message untouched when
   * the lookup misses (no project registry, not a GitHub topic, no
   * matching project). Idempotent — already-stamped payloads are skipped.
   */
  private _enrichGithub(msg: BusMessage): BusMessage {
    const payload = msg.payload as Record<string, unknown> | undefined;
    if (!payload) return msg;
    if (payload.projectSlug !== undefined) return msg;
    if (!msg.topic.startsWith(TOPICS.MESSAGE_INBOUND_GITHUB_PREFIX)) return msg;

    const projectRegistry = this.config.projectRegistry;
    if (!projectRegistry) return msg;

    const github = payload.github as Record<string, unknown> | undefined;
    const owner = github?.owner as string | undefined;
    const repo = github?.repo as string | undefined;
    if (!owner || !repo) return msg;

    const project = projectRegistry.getByGithub(`${owner}/${repo}`);
    if (!project) return msg;

    const channelRegistry = this.config.channelRegistry;
    const dev = channelRegistry?.getProjectChannel(project.slug, "dev")?.channelId;
    const release = channelRegistry?.getProjectChannel(project.slug, "release")?.channelId;

    return {
      ...msg,
      id: crypto.randomUUID(),
      payload: {
        ...payload,
        projectSlug: project.slug,
        projectPath: project.path,
        discordChannels: {
          ...(dev ? { dev } : {}),
          ...(release ? { release } : {}),
        },
      },
    };
  }

  private async _handleInbound(msg: BusMessage): Promise<void> {
    if (!this.bus) return;

    const payload = msg.payload as InboundMessagePayload;

    // Skip system/internal messages that surface plugins re-publish for their
    // own routing. We detect these by checking if the message has already
    // been routed.
    if (payload._routed) return;

    // Enrich GitHub messages with projectSlug + discordChannels.
    const workingMsg = this._enrichGithub(msg);
    const workingPayload = workingMsg.payload as InboundMessagePayload;

    const skillHint = workingPayload.skillHint;
    const content = workingPayload.content;
    const isDM = workingPayload.isDM === true;

    // Channel-based agent assignment — takes priority over keyword agent matching.
    // If channels.yaml assigns this channel to a specific agent, prefer that.
    const channelEntry = this.config.channelRegistry?.findByTopic(msg.topic);
    const channelAgent = channelEntry?.agent;

    // ── DM conversation stickiness ─────────────────────────────────────────
    const conversationId = workingMsg.correlationId;
    const storedSession = isDM ? this.dmSessions.get(conversationId) : undefined;

    let match = this.resolver.resolve(skillHint, content);

    if (isDM && !match && !storedSession) {
      // No keyword match and no active session — check DM default fallback.
      const defaultAgent = process.env.ROUTER_DM_DEFAULT_AGENT;
      const defaultSkill = process.env.ROUTER_DM_DEFAULT_SKILL ?? "chat";
      if (defaultAgent) {
        match = { skill: defaultSkill, agentName: defaultAgent, via: "default" };
      }
    }

    if (!match && !storedSession) {
      console.log(
        `[router] No skill match for topic "${msg.topic}"` +
        (content ? ` content="${content.slice(0, 60)}"` : "") +
        " — dropping",
      );
      const linearEvent = extractLinearEvent(msg.topic);
      if (linearEvent) {
        console.log(`[linear] event=${linearEvent} delivered to none (no skill match)`);
      }
      return;
    }

    let agentName: string | undefined;
    let skill: string;

    if (storedSession) {
      this.dmSessions.set(conversationId, storedSession);
      agentName = channelAgent ?? storedSession.agentName;
      skill = match?.skill ?? storedSession.skill;
    } else {
      agentName = channelAgent ?? match!.agentName;
      skill = match!.skill;
    }

    if (isDM && !storedSession && agentName) {
      this.dmSessions.set(conversationId, { agentName, skill });
    }

    const targets = agentName ? [agentName] : [];

    const runId = crypto.randomUUID();
    const replyTopic =
      (workingMsg.reply?.topic) ??
      `agent.skill.response.${runId}`;

    const via = match?.via ?? "sticky";
    console.log(
      `[router] ${msg.topic} → skill "${skill}" (via ${via})` +
      (agentName ? ` [${agentName}]` : "") +
      ` reply → ${replyTopic}`,
    );

    const linearEvent = extractLinearEvent(msg.topic);
    if (linearEvent) {
      console.log(
        `[linear] event=${linearEvent} delivered to ${agentName ?? "none"} (skill=${skill})`,
      );
    }

    const skillRequest: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: workingMsg.correlationId,
      parentId: workingMsg.id,
      topic: TOPICS.AGENT_SKILL_REQUEST,
      timestamp: Date.now(),
      payload: {
        ...workingPayload,
        skill,
        content,
        prompt: content,
        targets: targets.length ? targets : undefined,
        _routed: true,
        runId,
      },
      reply: { topic: replyTopic },
      source: workingMsg.source,
    };

    this.bus.publish(TOPICS.AGENT_SKILL_REQUEST, skillRequest);
  }

  private async _handleCron(msg: BusMessage): Promise<void> {
    if (!this.bus) return;

    const payload = msg.payload as CronPayload;
    const content = payload.content;
    const skillHint = payload.skillHint;
    const channel = payload.channel ?? "cli";
    const recipient = payload.recipient;

    if (channel === "a2a") return;

    const match = this.resolver.resolve(skillHint, content);

    if (!match) {
      console.log(`[router] cron "${msg.topic}" — no skill match, dropping`);
      return;
    }

    const runId = crypto.randomUUID();

    const replyTopic = msg.reply?.topic ?? buildReplyTopic(channel, recipient);

    console.log(
      `[router] cron "${msg.topic}" → skill "${match.skill}" (via ${match.via}) → ${replyTopic}`,
    );

    const skillRequest: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      parentId: msg.id,
      topic: TOPICS.AGENT_SKILL_REQUEST,
      timestamp: Date.now(),
      payload: {
        ...payload,
        skill: match.skill,
        content,
        prompt: content,
        _routed: true,
        runId,
      },
      reply: { topic: replyTopic },
      source: msg.source ?? { interface: "cron" },
    };

    this.bus.publish(TOPICS.AGENT_SKILL_REQUEST, skillRequest);
  }
}
