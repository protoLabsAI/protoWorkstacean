/**
 * PlaneDiscordNotifierPlugin — forwards Plane webhook issue events to a
 * project's Discord dev channel as notification embeds.
 *
 * Loads workspace/projects.yaml at startup and builds a mapping from
 * Plane project ID → Discord channel ID (prefers discord.dev, falls back
 * to discord.general). Projects without any Discord channel configured
 * are excluded from the mapping.
 *
 * This is NOT a HITL sink — it's a one-way notifier. The file was
 * originally named plane-hitl.ts but that was a naming lie: no HITL
 * approval flow happens here, just outbound Discord posts. Renamed for
 * clarity.
 *
 * Inbound topics consumed:
 *   message.inbound.plane.issue.# — published by PlanePlugin
 *
 * Outbound:
 *   message.outbound.discord.push.{channelId} — posts a Discord message
 *
 * Config: workspace/projects.yaml
 */

import { readFileSync, existsSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EventBus, BusMessage, Plugin } from "../types.ts";
import { validateProjectEntry, channelIdOf } from "../project-schema.ts";

// ── Internal types ────────────────────────────────────────────────────────────

interface ProjectMapping {
  slug: string;
  planeProjectId: string | undefined;
  discordChannelId: string; // resolved dev or general channel
}

// ── Index builder ──────────────────────────────────────────────────────────────

function buildMapping(projectsPath: string): Map<string, ProjectMapping> {
  // Key: planeProjectId (when set) or slug (fallback for event matching)
  const mapping = new Map<string, ProjectMapping>();

  if (!existsSync(projectsPath)) {
    return mapping;
  }

  let rawProjects: unknown[];
  try {
    const raw = readFileSync(projectsPath, "utf8");
    const parsed = parseYaml(raw) as { projects?: unknown[] };
    rawProjects = parsed.projects ?? [];
  } catch (err) {
    console.error(`[plane-discord-notifier] Failed to parse ${projectsPath}:`, err);
    return mapping;
  }

  for (const rawProject of rawProjects) {
    const validation = validateProjectEntry(rawProject);
    if (!validation.ok) {
      const slug = (rawProject as Record<string, unknown>)?.slug ?? "(unknown)";
      console.warn(`[plane-discord-notifier] Skipping invalid project "${slug}": ${validation.errors.join("; ")}`);
      continue;
    }

    const project = validation.entry;
    if (project.status === "archived" || project.status === "suspended") continue;

    // Resolve Discord channel: prefer dev, fall back to general
    const devId = channelIdOf(project.discord.dev).trim();
    const generalId = channelIdOf(project.discord.general).trim();
    const discordChannelId = devId || generalId;

    if (!discordChannelId) continue; // no Discord channel — skip

    const key = project.planeProjectId ?? project.slug;
    mapping.set(key, {
      slug: project.slug,
      planeProjectId: project.planeProjectId,
      discordChannelId,
    });
  }

  return mapping;
}

// ── Plugin ─────────────────────────────────────────────────────────────────────

export class PlaneDiscordNotifierPlugin implements Plugin {
  readonly name = "plane-discord-notifier";
  readonly description =
    "Plane → Discord notifier: forwards Plane issue events to project Discord channels as one-way embeds";
  readonly capabilities = ["plane-discord-routing"];

  private workspaceDir: string;
  private mapping: Map<string, ProjectMapping> = new Map();

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  install(bus: EventBus): void {
    const projectsPath = join(this.workspaceDir, "projects.yaml");
    this.mapping = buildMapping(projectsPath);
    console.log(
      `[plane-discord-notifier] Loaded ${this.mapping.size} project(s) with Plane→Discord mapping`,
    );

    // Hot-reload on file change
    if (existsSync(projectsPath)) {
      watchFile(projectsPath, { interval: 5_000 }, () => {
        this.mapping = buildMapping(projectsPath);
        console.log(
          `[plane-discord-notifier] projects.yaml changed — reloaded ${this.mapping.size} project(s)`,
        );
      });
    }

    // Subscribe to Plane inbound issue events
    bus.subscribe("message.inbound.plane.issue.#", this.name, (msg: BusMessage) => {
      this._handleIssueEvent(bus, msg);
    });
  }

  uninstall(): void {
    const projectsPath = join(this.workspaceDir, "projects.yaml");
    unwatchFile(projectsPath);
  }

  private _handleIssueEvent(bus: EventBus, msg: BusMessage): void {
    const payload = msg.payload as Record<string, unknown> | undefined;
    if (!payload) return;

    const planeProjectId = String(payload.planeProjectId ?? "");

    // Look up by planeProjectId first, then try slug-based fallback keys
    const project = this._resolveProject(planeProjectId);
    if (!project) {
      // No Discord mapping for this project — nothing to do
      return;
    }

    const title = String(payload.title ?? "New Plane issue");
    const description = String(payload.description ?? "");
    const priority = String(payload.priority ?? "none");
    const issueId = String(payload.planeIssueId ?? "");
    const seqId = payload.planeSequenceId != null ? `#${payload.planeSequenceId}` : "";

    const lines: string[] = [
      `**[Plane] New issue ${seqId}** — ${title}`,
      `Priority: **${priority}**`,
    ];
    if (description && description !== title) {
      lines.push(`> ${description.slice(0, 280)}`);
    }
    lines.push(`Project: ${project.slug} | Issue ID: \`${issueId}\``);

    const content = lines.join("\n");

    const outboundTopic = `message.outbound.discord.push.${project.discordChannelId}`;
    bus.publish(outboundTopic, {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: outboundTopic,
      timestamp: Date.now(),
      payload: { content },
      source: msg.source,
    });

    console.log(
      `[plane-discord-notifier] Issue "${title}" (${issueId}) → Discord channel ${project.discordChannelId} (${project.slug})`,
    );
  }

  private _resolveProject(planeProjectId: string): ProjectMapping | undefined {
    if (!planeProjectId) return undefined;
    // Direct lookup by planeProjectId (UUID from Plane)
    if (this.mapping.has(planeProjectId)) return this.mapping.get(planeProjectId);
    // Fallback: scan by planeProjectId field value
    for (const entry of this.mapping.values()) {
      if (entry.planeProjectId === planeProjectId) return entry;
    }
    return undefined;
  }
}
