/**
 * RouterPlugin — routes inbound messages to agents via agent.skill.request.
 *
 * This plugin replaces both:
 *   - AgentPlugin (@mariozechner/pi-coding-agent) — the old Pi SDK catch-all handler
 *   - A2APlugin — GitHub message enricher (projectSlug + Discord channels)
 *
 * It makes no LLM calls and holds no agent state. Its only job is to translate
 * inbound bus messages into skill requests that AgentRuntimePlugin (in-process)
 * or SkillBrokerPlugin (external A2A fallback) will execute.
 *
 * Subscribes to:
 *   message.inbound.#  — from Discord, GitHub, Plane, Google, HTTP API
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
 * Config:
 *   workspace/agents/*.yaml       — skill keyword definitions
 *   workspace/projects.yaml       — project registry for GitHub enrichment
 *   ROUTER_DEFAULT_SKILL env var  — fallback skill when nothing matches
 *   DISABLE_ROUTER env var        — set to skip loading this plugin
 */

import { existsSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { InboundMessagePayload, CronPayload } from "../event-bus/payloads.ts";
import { SkillResolver } from "./skill-resolver.ts";
import { ProjectEnricher } from "./project-enricher.ts";
import { loadAgentDefinitions } from "../agent-runtime/agent-definition-loader.ts";
import type { ChannelRegistry } from "../../lib/channels/channel-registry.ts";
import { TTLCache } from "../../lib/ttl-cache.ts";
import { TOPICS } from "../event-bus/topics.ts";

export interface RouterConfig {
  workspaceDir: string;
  /** Fallback skill when no hint or keyword matches. Default: ROUTER_DEFAULT_SKILL env var. */
  defaultSkill?: string;
  /**
   * Optional channel registry. When provided, inbound messages from a channel
   * with an explicit agent assignment are routed directly to that agent without
   * requiring a keyword match.
   */
  channelRegistry?: ChannelRegistry;
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

  private bus?: EventBus;
  private readonly resolver: SkillResolver;
  private readonly enricher = new ProjectEnricher();
  private readonly subscriptionIds: string[] = [];
  private readonly config: RouterConfig;
  private reloadDebounce: ReturnType<typeof setTimeout> | null = null;

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

    // Load project enrichment index
    const projectsPath = join(this.config.workspaceDir, "projects.yaml");
    this.enricher.load(projectsPath);

    // Load skill keyword map from agent definitions
    this._reloadSkills();

    // Watch projects.yaml for live updates (no restart needed)
    if (existsSync(projectsPath)) {
      watchFile(projectsPath, { interval: 5_000 }, () => {
        if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
        this.reloadDebounce = setTimeout(() => {
          this.reloadDebounce = null;
          this.enricher.load(projectsPath);
          console.log("[router] projects.yaml reloaded");
        }, 300);
      });
    }

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
      `[router] Plugin installed — ` +
      `${this.enricher.size} project(s), ` +
      `${this.resolver.size} skill keyword entry/entries`,
    );
  }

  uninstall(): void {
    if (this.reloadDebounce) {
      clearTimeout(this.reloadDebounce);
      this.reloadDebounce = null;
    }
    if (this.bus) {
      for (const id of this.subscriptionIds) this.bus.unsubscribe(id);
    }
    this.subscriptionIds.length = 0;
    this.bus = undefined;

    const projectsPath = join(this.config.workspaceDir, "projects.yaml");
    unwatchFile(projectsPath);
  }

  private _reloadSkills(): void {
    const defs = loadAgentDefinitions(this.config.workspaceDir);
    this.resolver.loadFromAgents(defs);
  }

  private async _handleInbound(msg: BusMessage): Promise<void> {
    if (!this.bus) return;

    const payload = msg.payload as InboundMessagePayload;

    // Skip system/internal messages that surface plugins re-publish for their
    // own routing (e.g., enriched GitHub messages from the old A2APlugin).
    // We detect these by checking if the message has already been routed.
    if (payload._routed) return;

    // Enrich GitHub messages with projectSlug + discordChannels.
    // enricher.enrich() returns null if the message is already enriched,
    // not a GitHub message, or the repo isn't in the project registry.
    const enriched = this.enricher.enrich(msg);
    const workingMsg = enriched ?? msg;
    const workingPayload = workingMsg.payload as InboundMessagePayload;

    const skillHint = workingPayload.skillHint;
    const content = workingPayload.content;
    const isDM = workingPayload.isDM === true;

    // Agent pool DMs bypass the router entirely — DiscordPlugin publishes
    // directly to agent.skill.request with the target agent. Only main bot
    // DMs (no agentId) come through here.

    // Channel-based agent assignment — takes priority over keyword agent matching.
    // If channels.yaml assigns this channel to a specific agent, prefer that.
    const channelEntry = this.config.channelRegistry?.findByTopic(msg.topic);
    const channelAgent = channelEntry?.agent;

    // ── DM conversation stickiness ─────────────────────────────────────────
    // Once an agent/skill is matched for a DM conversation, reuse it for all
    // subsequent turns so the conversation stays with the same agent regardless
    // of whether later messages contain matching keywords.
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
      return;
    }

    // Resolve final agent/skill — stored DM session takes priority over fresh match
    // for agent assignment (so conversation stays sticky), but a keyword match with
    // a different skill is still honoured (e.g. "triage this bug" mid-conversation).
    let agentName: string | undefined;
    let skill: string;

    if (storedSession) {
      // Re-set TTL on every turn (sliding window)
      this.dmSessions.set(conversationId, storedSession);
      agentName = channelAgent ?? storedSession.agentName;
      skill = match?.skill ?? storedSession.skill;
    } else {
      agentName = channelAgent ?? match!.agentName;
      skill = match!.skill;
    }

    // Store new DM session if this is the first matched turn
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

    const skillRequest: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: workingMsg.correlationId,
      parentId: workingMsg.id,
      topic: TOPICS.AGENT_SKILL_REQUEST,
      timestamp: Date.now(),
      payload: {
        // Forward enriched payload fields (includes projectSlug if enriched)
        ...workingPayload,
        // Routing metadata — overrides any matching fields from original payload
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

    const match = this.resolver.resolve(skillHint, content);

    if (!match) {
      console.log(`[router] cron "${msg.topic}" — no skill match, dropping`);
      return;
    }

    const runId = crypto.randomUUID();

    // Construct reply topic from channel/recipient (matches AgentPlugin's old logic)
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
