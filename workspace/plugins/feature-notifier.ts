/**
 * FeatureNotifierPlugin — project-aware Discord notifications for feature lifecycle events.
 *
 * Subscribes to:
 *   feature.completed   → posts a ✅ embed to the project's dev channel
 *   feature.failed      → posts a ❌ embed to the project's dev channel
 *
 * Channel routing: looks up `discord.dev` from workspace/projects.yaml by projectSlug.
 * Posts via the bus topic `message.outbound.discord.push.{channelId}` — handled by
 * DiscordPlugin which routes to the correct bot client.
 *
 * Config: workspace/projects.yaml (hot-reloaded on change)
 *
 * Called by protoMaker via POST /publish:
 *   { topic: "feature.completed", payload: { projectSlug, featureId, featureTitle, branchName, prNumber? } }
 *   { topic: "feature.failed",    payload: { projectSlug, featureId, featureTitle, error? } }
 */

import { readFileSync, existsSync, watchFile } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml } from "yaml";

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

interface ProjectEntry {
  slug: string;
  title?: string;
  discord?: {
    dev?: string;
    devWebhook?: string;
    [key: string]: string | undefined;
  };
}

interface ProjectRecord {
  title: string;
  devChannelId: string;
  devWebhook: string;
}

// ── Env var expansion ─────────────────────────────────────────────────────────

function expandEnv(val: string | undefined): string {
  if (!val) return "";
  return val.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? "");
}

// ── Project index ─────────────────────────────────────────────────────────────

function buildIndex(workspaceDir: string): Map<string, ProjectRecord> {
  const index = new Map<string, ProjectRecord>();
  const path = join(workspaceDir, "projects.yaml");
  if (!existsSync(path)) return index;

  try {
    const raw = readFileSync(path, "utf8");
    const { projects = [] } = parseYaml(raw) as { projects?: ProjectEntry[] };
    for (const p of projects) {
      const devChannelId = p.discord?.dev ?? "";
      const devWebhook = expandEnv(p.discord?.devWebhook ?? "");
      if (devChannelId || devWebhook) {
        index.set(p.slug, {
          title: p.title ?? p.slug,
          devChannelId,
          devWebhook,
        });
      }
    }
    console.log(`[feature-notifier] Loaded ${index.size} project(s) with dev channel`);
  } catch (err) {
    console.error("[feature-notifier] Failed to load projects.yaml:", err);
  }

  return index;
}

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

// ── Plugin ────────────────────────────────────────────────────────────────────

const workspaceDir = resolve(process.env.WORKSPACE_DIR ?? join(process.cwd(), "workspace"));
let projectIndex = buildIndex(workspaceDir);

// Hot-reload on projects.yaml change
const projectsPath = join(workspaceDir, "projects.yaml");
if (existsSync(projectsPath)) {
  watchFile(projectsPath, { interval: 5_000 }, () => {
    console.log("[feature-notifier] projects.yaml changed — reloading");
    projectIndex = buildIndex(workspaceDir);
  });
}

function handleFeatureEvent(
  bus: EventBus,
  msg: BusMessage,
  formatter: (p: Record<string, unknown>) => string
): void {
  const payload = (msg.payload ?? {}) as Record<string, unknown>;
  const slug = String(payload.projectSlug ?? "");

  if (!slug) {
    console.warn("[feature-notifier] feature event missing projectSlug — skipping");
    return;
  }

  const project = projectIndex.get(slug);
  if (!project) {
    console.warn(`[feature-notifier] No dev channel configured for project "${slug}"`);
    return;
  }

  const content = formatter(payload);

  if (project.devChannelId) {
    bus.publish(`message.outbound.discord.push.${project.devChannelId}`, {
      correlationId: msg.correlationId,
      payload: { content, channel: project.devChannelId },
    });
    console.log(`[feature-notifier] Posted to ${project.title} dev channel (${project.devChannelId})`);
  } else if (project.devWebhook) {
    // Fallback: direct webhook POST (used when bot not available)
    fetch(project.devWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }).catch((err) => console.error("[feature-notifier] Webhook POST failed:", err));
    console.log(`[feature-notifier] Webhook POST to ${project.title} dev channel`);
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

  uninstall(_bus: EventBus) {},
};
