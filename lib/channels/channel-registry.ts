/**
 * ChannelRegistry — loads and indexes workspace/channels.yaml.
 *
 * Provides O(1) lookups used by RouterPlugin (topic → agent) and
 * DiscordPlugin (agent → bot token env key).
 *
 * Hot-reloads when channels.yaml changes on disk (5s poll interval).
 * All consumers share a single registry instance created at startup.
 */

import { readFileSync, existsSync, watchFile, unwatchFile } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { Channel, ChannelsYaml } from "../types/channels.ts";

export type { Channel };

export class ChannelRegistry {
  private channels: Channel[] = [];

  // Index: discord channelId → Channel
  private byDiscordChannel = new Map<string, Channel>();
  // Index: "owner/repo" → Channel
  private byGithubRepo = new Map<string, Channel>();
  // Index: signal groupId → Channel
  private bySignalGroup = new Map<string, Channel>();
  // Index: slack channelId → Channel
  private bySlackChannel = new Map<string, Channel>();
  // Index: gmail label-slug → Channel (slug = lowercase, non-alphanum → "-")
  private byGoogleGmailLabel = new Map<string, Channel>();

  private filePath: string;
  private watching = false;
  private reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
    this._load();
  }

  // ── Lookup API ────────────────────────────────────────────────────────────────

  /**
   * Resolve a bus topic to a Channel entry.
   *
   * Supported topic patterns:
   *   message.inbound.discord.{channelId}
   *   message.inbound.github.{owner}.{repo}.*
   *   message.inbound.signal.{groupId}
   *   message.inbound.slack.{channelId}
   *   message.inbound.google.gmail.{labelSlug}.{threadId}
   */
  findByTopic(topic: string): Channel | undefined {
    const parts = topic.split(".");
    // message.inbound.{platform}.{...}
    if (parts[0] !== "message" || parts[1] !== "inbound") return undefined;
    const platform = parts[2];

    if (platform === "discord" && parts[3]) {
      return this.byDiscordChannel.get(parts[3]);
    }
    if (platform === "github" && parts[3] && parts[4]) {
      return this.byGithubRepo.get(`${parts[3]}/${parts[4]}`);
    }
    if (platform === "signal" && parts[3]) {
      return this.bySignalGroup.get(parts[3]);
    }
    if (platform === "slack" && parts[3]) {
      return this.bySlackChannel.get(parts[3]);
    }
    if (platform === "google" && parts[3] === "gmail" && parts[4]) {
      return this.byGoogleGmailLabel.get(parts[4]);
    }
    return undefined;
  }

  /**
   * Normalize a Gmail label name into the topic-safe slug used as the
   * channels.yaml lookup key. Lowercase, non-alphanumeric → "-".
   * Examples: "INBOX" → "inbox", "Personal/Work" → "personal-work".
   */
  static gmailLabelSlug(label: string): string {
    return label.toLowerCase().replace(/[^a-z0-9]/g, "-");
  }

  /** All enabled Discord channel entries. */
  getDiscordChannels(): Channel[] {
    return this.channels.filter(c => c.platform === "discord" && c.enabled !== false && c.channelId);
  }

  /**
   * Map of agentName → botTokenEnvKey for all Discord channels that specify
   * a per-agent bot token. Used by DiscordPlugin to build its client pool.
   */
  getDiscordBotTokenEnvs(): Map<string, string> {
    const result = new Map<string, string>();
    for (const ch of this.getDiscordChannels()) {
      if (ch.agent && ch.agentBotTokenEnv) {
        result.set(ch.agent, ch.agentBotTokenEnv);
      }
    }
    return result;
  }

  /**
   * Map of agentName → channelIds[] for Discord. Used by DiscordPlugin to
   * know which channels each agent's bot client should listen on.
   */
  getDiscordChannelsByAgent(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const ch of this.getDiscordChannels()) {
      if (!ch.agent || !ch.channelId) continue;
      const existing = result.get(ch.agent) ?? [];
      existing.push(ch.channelId);
      result.set(ch.agent, existing);
    }
    return result;
  }

  /** All entries (enabled and disabled). */
  getAll(): Channel[] {
    return [...this.channels];
  }

  /** Number of loaded channel entries. */
  get size(): number {
    return this.channels.length;
  }

  // ── Write API ─────────────────────────────────────────────────────────────────

  /**
   * Append a new channel entry to channels.yaml and reload the index.
   * Throws if a channel with the same id already exists.
   */
  add(channel: Channel): void {
    if (this.channels.some(c => c.id === channel.id)) {
      throw new Error(`Channel "${channel.id}" already exists`);
    }
    const updated = [...this.channels, channel];
    const yaml: ChannelsYaml = { channels: updated };
    const { writeFileSync } = require("node:fs") as typeof import("node:fs");
    writeFileSync(this.filePath, stringifyYaml(yaml), "utf8");
    this._buildIndex(updated);
    console.log(`[channel-registry] Added channel "${channel.id}" (${channel.platform})`);
  }

  // ── Hot-reload ────────────────────────────────────────────────────────────────

  startWatching(): void {
    if (this.watching || !existsSync(this.filePath)) return;
    this.watching = true;
    watchFile(this.filePath, { interval: 5_000 }, () => {
      if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
      this.reloadDebounce = setTimeout(() => {
        this.reloadDebounce = null;
        this._load();
        console.log(`[channel-registry] Reloaded — ${this.channels.length} channel(s)`);
      }, 300);
    });
  }

  stopWatching(): void {
    if (!this.watching) return;
    this.watching = false;
    unwatchFile(this.filePath);
    if (this.reloadDebounce) {
      clearTimeout(this.reloadDebounce);
      this.reloadDebounce = null;
    }
  }

  reload(): void {
    this._load();
  }

  // ── Internals ─────────────────────────────────────────────────────────────────

  private _load(): void {
    if (!existsSync(this.filePath)) {
      this._buildIndex([]);
      return;
    }
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = parseYaml(raw) as ChannelsYaml;
      this._buildIndex(parsed.channels ?? []);
    } catch (err) {
      console.error(`[channel-registry] Failed to load ${this.filePath}:`, err);
    }
  }

  private _buildIndex(channels: Channel[]): void {
    this.channels = channels;
    this.byDiscordChannel.clear();
    this.byGithubRepo.clear();
    this.bySignalGroup.clear();
    this.bySlackChannel.clear();
    this.byGoogleGmailLabel.clear();

    for (const ch of channels) {
      if (ch.enabled === false) continue;
      switch (ch.platform) {
        case "discord":
          if (ch.channelId) this.byDiscordChannel.set(ch.channelId, ch);
          break;
        case "github":
          if (ch.repo) this.byGithubRepo.set(ch.repo, ch);
          break;
        case "signal":
          if (ch.groupId) this.bySignalGroup.set(ch.groupId, ch);
          break;
        case "slack":
          if (ch.slackChannelId) this.bySlackChannel.set(ch.slackChannelId, ch);
          break;
        case "google":
          // Gmail entries use channelId as the label name (e.g. "INBOX",
          // "Personal/Work"). Normalize to a topic-safe slug so the topic
          // segment matches.
          if (ch.channelId) {
            this.byGoogleGmailLabel.set(ChannelRegistry.gmailLabelSlug(ch.channelId), ch);
          }
          break;
      }
    }
  }
}
