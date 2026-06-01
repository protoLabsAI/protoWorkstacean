/**
 * FeatureNotifierPlugin — project-aware Discord notifications for feature
 * lifecycle events (the protoMaker → workstacean reporting leg, ADR-0002).
 *
 * Subscribes to:
 *   feature.completed   → posts a ✅ message to the project's dev channel
 *   feature.failed      → posts a ❌ message to the project's dev channel
 *
 * Channel routing: resolves `(projectSlug, "dev")` against the shared
 * ChannelRegistry (workspace/channels.yaml) and posts via the bus topic
 * `message.outbound.discord.push.{channelId}` (handled by DiscordPlugin, which
 * routes to the correct bot client). When no bot channel is bound, falls back
 * to a direct webhook POST using `webhook:` from the same channels.yaml entry.
 *
 * Driven by protoMaker via POST /publish:
 *   { topic: "feature.completed", payload: { projectSlug, featureId, featureTitle, branchName, prNumber?, repo? } }
 *   { topic: "feature.failed",    payload: { projectSlug, featureId, featureTitle, error? } }
 *
 * First-party (compiled into the image) rather than a workspace plugin:
 * workspace plugins load from a bind-mount outside the app's module tree, so
 * they can't resolve app internals (lib/ or node_modules) at runtime — which is
 * exactly why the prior workspace/plugins/feature-notifier.ts never loaded in
 * the container. The shared ChannelRegistry is injected, mirroring how
 * RouterPlugin / DiscordPlugin receive it.
 */

import type { ChannelRegistry } from "../channels/channel-registry.ts";
import type { Plugin, EventBus, BusMessage } from "../types.ts";

function expandEnv(val: string | undefined): string {
  if (!val) return "";
  return val.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? "");
}

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

export class FeatureNotifierPlugin implements Plugin {
  name = "feature-notifier";
  description = "Project-aware Discord notifications for feature completion and failure";
  capabilities = ["feature.completed", "feature.failed"];

  private readonly channelRegistry: ChannelRegistry;
  private subscriptionIds: string[] = [];

  constructor(opts: { channelRegistry: ChannelRegistry }) {
    this.channelRegistry = opts.channelRegistry;
  }

  install(bus: EventBus): void {
    this.subscriptionIds.push(
      bus.subscribe("feature.completed", "feature-notifier-done", (msg) => {
        this.handle(bus, msg, formatCompleted);
      }),
      bus.subscribe("feature.failed", "feature-notifier-fail", (msg) => {
        this.handle(bus, msg, formatFailed);
      }),
    );
    console.log("[feature-notifier] Installed — watching feature.completed + feature.failed");
  }

  uninstall(): void {
    // Bus subscriptions drop on teardown; the ChannelRegistry is shared and
    // owned elsewhere, so we don't touch its lifecycle.
    this.subscriptionIds = [];
  }

  private handle(bus: EventBus, msg: BusMessage, formatter: (p: Record<string, unknown>) => string): void {
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    const slug = String(payload.projectSlug ?? "");
    if (!slug) {
      console.warn("[feature-notifier] feature event missing projectSlug — skipping");
      return;
    }

    const channel = this.channelRegistry.getProjectChannel(slug, "dev");
    if (!channel) {
      console.warn(`[feature-notifier] No dev channel binding for project "${slug}" in channels.yaml — skipping`);
      return;
    }

    const content = formatter(payload);
    const channelId = channel.channelId;
    const webhook = expandEnv(channel.webhook);

    if (channelId) {
      const topic = `message.outbound.discord.push.${channelId}`;
      bus.publish(topic, {
        id: crypto.randomUUID(),
        correlationId: msg.correlationId,
        topic,
        timestamp: Date.now(),
        payload: { content, channel: channelId },
      });
      console.log(`[feature-notifier] Posted to ${slug} dev channel (${channelId})`);
    } else if (webhook) {
      // Fallback: direct webhook POST (used when no bot channel is bound).
      fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      }).catch((err) => console.error("[feature-notifier] Webhook POST failed:", err));
      console.log(`[feature-notifier] Webhook POST to ${slug} dev channel`);
    }
  }
}
