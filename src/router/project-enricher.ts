/**
 * ProjectEnricher — stamps projectSlug and Discord channel IDs onto inbound
 * GitHub messages by looking up the repo in workspace/projects.yaml.
 *
 * This absorbs the A2APlugin's enrichment logic. The A2APlugin can be
 * disabled once RouterPlugin is active.
 *
 * Enrichment is idempotent — messages already carrying projectSlug are skipped.
 */

import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { BusMessage } from "../../lib/types.ts";

interface ProjectDiscordChannels {
  general?: string;
  updates?: string;
  dev?: string;
  alerts?: string;
  releases?: string;
}

interface ProjectRecord {
  projectSlug: string;
  discordChannels: ProjectDiscordChannels;
}

export class ProjectEnricher {
  private index = new Map<string, ProjectRecord>(); // "owner/repo" → record

  load(projectsPath: string): void {
    this.index = new Map();
    if (!existsSync(projectsPath)) return;

    let rawProjects: unknown[];
    try {
      const raw = readFileSync(projectsPath, "utf8");
      const parsed = parseYaml(raw) as { projects?: unknown[] };
      rawProjects = parsed.projects ?? [];
    } catch (err) {
      console.error("[router:enricher] Failed to parse projects.yaml:", err);
      return;
    }

    for (const rawProject of rawProjects) {
      const p = rawProject as Record<string, unknown>;
      const slug = typeof p.slug === "string" ? p.slug : undefined;
      const github = typeof p.github === "string" ? p.github : undefined;
      const status = typeof p.status === "string" ? p.status : undefined;

      if (!slug || !github || !status) {
        console.warn(`[router:enricher] Skipping project: missing slug, github, or status`);
        continue;
      }
      if (status === "archived" || status === "suspended") continue;
      if (!/^[^/]+\/[^/]+$/.test(github)) {
        console.warn(`[router:enricher] Skipping project "${slug}": invalid github format "${github}"`);
        continue;
      }

      // Support both flat discord shape (discord.dev) and nested (discord.channels.dev)
      const disc = p.discord as Record<string, unknown> | undefined;
      const channels = (disc?.channels as Record<string, string> | undefined) ?? disc;

      this.index.set(github, {
        projectSlug: slug,
        discordChannels: {
          general: channels?.general as string | undefined,
          updates: channels?.updates as string | undefined,
          dev: channels?.dev as string | undefined,
          alerts: channels?.alerts as string | undefined,
          releases: channels?.releases as string | undefined,
        },
      });
    }

    console.log(`[router:enricher] Loaded ${this.index.size} active project(s)`);
  }

  /**
   * Enrich a GitHub inbound message with projectSlug + discordChannels.
   * Returns an enriched copy, or null if the message should not be enriched
   * (not a GitHub message, already enriched, or repo not in registry).
   */
  enrich(msg: BusMessage): BusMessage | null {
    const payload = msg.payload as Record<string, unknown> | undefined;
    if (!payload) return null;

    // Already enriched — skip to prevent infinite re-publish loops
    if (payload.projectSlug !== undefined) return null;

    // Only enrich GitHub inbound messages
    if (!msg.topic.startsWith("message.inbound.github.")) return null;

    const github = payload.github as Record<string, unknown> | undefined;
    const owner = github?.owner as string | undefined;
    const repo = github?.repo as string | undefined;
    if (!owner || !repo) return null;

    const match = this.index.get(`${owner}/${repo}`);
    if (!match) return null;

    return {
      ...msg,
      id: crypto.randomUUID(),
      payload: {
        ...payload,
        projectSlug: match.projectSlug,
        discordChannels: match.discordChannels,
      },
    };
  }

  get size(): number {
    return this.index.size;
  }
}
