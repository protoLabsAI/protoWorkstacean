/**
 * FeatureNotifierPlugin — project-aware Discord notifications for feature lifecycle events.
 *
 * Subscribes to:
 *   feature.completed   → posts a ✅ embed to the project's dev channel
 *   feature.failed      → posts a ❌ embed to the project's dev channel
 *
 * Channel routing: looks up `(projectSlug, "dev")` in workspace/channels.yaml
 * via the in-process ChannelRegistry. Posts via the bus topic
 * `message.outbound.discord.push.{channelId}` — handled by DiscordPlugin which
 * routes to the correct bot client. When the bot isn't connected to the
 * channel, falls back to a direct webhook POST using `webhook:` from the
 * same channels.yaml entry.
 *
 * Called by protoMaker via POST /publish:
 *   { topic: "feature.completed", payload: { projectSlug, featureId, featureTitle, branchName, prNumber? } }
 *   { topic: "feature.failed",    payload: { projectSlug, featureId, featureTitle, error? } }
 */

import { resolve, join } from "node:path";
import { ChannelRegistry } from "../../lib/channels/channel-registry.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface BusMessage {
  topic?: string;
  correlationId: string;
  payload?: Record<string, unknown>;
  source?: unknown;
  [key: string]: unknown;
}

interface EventBus {
  publish(topic: string, message: BusMessage): void;
  subscribe(
    pattern: string,
    pluginName: string,
    handler: (msg: BusMessage) => void | Promise<void>
  ): string;
}

// ── Env var expansion ─────────────────────────────────────────────────────────

function expandEnv(val: string | undefined): string {
  if (!val) return "";
  return val.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? "");
}

// ── Channel registry — one shared instance, hot-reloads on channels.yaml change ─

const workspaceDir = resolve(process.env.WORKSPACE_DIR ?? join(process.cwd(), "workspace"));
const channelRegistry = new ChannelRegistry(join(workspaceDir, "channels.yaml"));
channelRegistry.startWatching();

// ── Notification formatting ───────────────────────────────────────────────────

function formatCompleted(payload: Record<string, unknown>): string {
  const title = String(payload.featureTitle ?? payload.featureId ?? "Feature");
  const id = payload.featureId ? `\`${payload.featureId}\`` : "";
  const pr = payload.prNumber ? ` · [PR #${payload.prNumber}](https://github.com/${payload.repo ?? ""}/pull/${payload.prNumber})` : "";
  return `✅ **Feature shipped:** ${title}${pr}${id ? `\n${id}` : ""}`;
}

function formatFailed(payload: Record<string, unknown>): string {
  const title = String(payload.featureTitle ?? payload.featureId ?? "Feature");
  const err = payload.error ? `\n> ${payload.error}` : "";
  return `❌ **Feature failed:** ${title}${err}`;
}

// ── Handler ───────────────────────────────────────────────────────────────────

function handleFeatureEvent(
  bus: EventBus,
  msg: BusMessage,
  formatter: (p: Record<string, unknown>) => string,
): void {
  const payload = (msg.payload ?? {}) as Record<string, unknown>;
  const slug = String(payload.projectSlug ?? "");

  if (!slug) {
    console.warn("[feature-notifier] feature event missing projectSlug — skipping");
    return;
  }

  const channel = channelRegistry.getProjectChannel(slug, "dev");
  if (!channel) {
    console.warn(`[feature-notifier] No dev channel binding for project "${slug}" in channels.yaml — skipping`);
    return;
  }

  const content = formatter(payload);
  const channelId = channel.channelId;
  const webhook = expandEnv(channel.webhook);

  if (channelId) {
    bus.publish(`message.outbound.discord.push.${channelId}`, {
      correlationId: msg.correlationId,
      payload: { content, channel: channelId },
    });
    console.log(`[feature-notifier] Posted to ${slug} dev channel (${channelId})`);
  } else if (webhook) {
    // Fallback: direct webhook POST (used when bot not available)
    fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }).catch((err) => console.error("[feature-notifier] Webhook POST failed:", err));
    console.log(`[feature-notifier] Webhook POST to ${slug} dev channel`);
  }
}

export default {
  name: "feature-notifier",
  description: "Project-aware Discord notifications for feature completion and failure",
  capabilities: ["feature.completed", "feature.failed"],

  install(bus: EventBus) {
    bus.subscribe("feature.completed", "feature-notifier-done", (msg) => {
      handleFeatureEvent(bus, msg, formatCompleted);
    });

    bus.subscribe("feature.failed", "feature-notifier-fail", (msg) => {
      handleFeatureEvent(bus, msg, formatFailed);
    });

    console.log("[feature-notifier] Installed — watching feature.completed + feature.failed");
  },

  uninstall(_bus: EventBus) {
    channelRegistry.stopWatching();
  },
};
