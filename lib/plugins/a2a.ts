/**
 * A2APlugin — project registry + GitHub message enrichment.
 *
 * Loads workspace/projects.yaml at startup and builds a repo-to-project
 * index. When GitHub inbound messages arrive on the bus, the plugin looks
 * up the repo and attaches projectSlug + discordChannels to the payload so
 * downstream consumers (Discord routing, agent skill selection) know which
 * project channels to target.
 *
 * Enrichment is idempotent: messages that already carry a projectSlug are
 * skipped to avoid re-processing re-published messages.
 *
 * Config: workspace/projects.yaml
 *
 *   projects:
 *     - slug: my-project
 *       github: owner/repo
 *       status: active
 *       discord:
 *         dev:      "channel-id"
 *         alerts:   "channel-id"
 *         releases: "channel-id"
 *
 * Inbound topics consumed (read-only enrichment):
 *   message.inbound.github.#
 *
 * Enriched messages are re-published on the same topic with the extra fields:
 *   payload.projectSlug     — project slug from projects.yaml
 *   payload.discordChannels — { dev?, alerts?, releases? }
 */

import { readFileSync, existsSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EventBus, BusMessage, Plugin } from "../types.ts";

// ── Config types ──────────────────────────────────────────────────────────────

interface ProjectDiscordChannels {
  dev?: string;
  alerts?: string;
  releases?: string;
}

interface ProjectEntry {
  slug: string;
  title?: string;
  github: string;
  defaultBranch?: string;
  status?: string;
  onboardedAt?: string;
  discord?: ProjectDiscordChannels;
}

interface ProjectsYaml {
  projects: ProjectEntry[];
}

interface ProjectIndex {
  projectSlug: string;
  discordChannels: ProjectDiscordChannels;
}

// ── Index builder ─────────────────────────────────────────────────────────────

function buildIndex(projectsPath: string): Map<string, ProjectIndex> {
  const index = new Map<string, ProjectIndex>();

  if (!existsSync(projectsPath)) {
    return index;
  }

  let parsed: ProjectsYaml;
  try {
    const raw = readFileSync(projectsPath, "utf8");
    parsed = parseYaml(raw) as ProjectsYaml;
  } catch (err) {
    console.error(`[a2a] Failed to parse ${projectsPath}:`, err);
    return index;
  }

  for (const project of parsed.projects ?? []) {
    if (!project.github || !project.slug) continue;
    if (project.status === "archived" || project.status === "suspended") continue;

    index.set(project.github, {
      projectSlug: project.slug,
      discordChannels: {
        dev: project.discord?.dev,
        alerts: project.discord?.alerts,
        releases: project.discord?.releases,
      },
    });
  }

  return index;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class A2APlugin implements Plugin {
  readonly name = "a2a";
  readonly description =
    "Project registry — enriches GitHub inbound messages with projectSlug and Discord channel IDs";
  readonly capabilities = ["github-enrichment", "project-registry"];

  private workspaceDir: string;
  private index: Map<string, ProjectIndex> = new Map();

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  install(bus: EventBus): void {
    const projectsPath = join(this.workspaceDir, "projects.yaml");
    this.index = buildIndex(projectsPath);
    console.log(`[a2a] Loaded ${this.index.size} active project(s) from projects.yaml`);

    // Re-index on file change so the process can pick up new entries without restart.
    if (existsSync(projectsPath)) {
      watchFile(projectsPath, { interval: 5_000 }, () => {
        this.index = buildIndex(projectsPath);
        console.log(`[a2a] projects.yaml changed — reloaded ${this.index.size} project(s)`);
      });
    }

    // Subscribe to all GitHub inbound messages.
    // We re-publish an enriched copy when a matching repo is found.
    bus.subscribe("message.inbound.github.#", this.name, (msg: BusMessage) => {
      this._enrich(bus, msg);
    });
  }

  uninstall(): void {
    const projectsPath = join(this.workspaceDir, "projects.yaml");
    // unwatchFile is a no-op if the file isn't being watched.
    unwatchFile(projectsPath);
  }

  private _enrich(bus: EventBus, msg: BusMessage): void {
    const payload = msg.payload as Record<string, unknown> | undefined;
    if (!payload) return;

    // Skip already-enriched messages to prevent infinite re-publish loops.
    if (payload.projectSlug !== undefined) return;

    const github = payload.github as Record<string, unknown> | undefined;
    if (!github) return;

    const owner = github.owner as string | undefined;
    const repo = github.repo as string | undefined;
    if (!owner || !repo) return;

    const repoKey = `${owner}/${repo}`;
    const match = this.index.get(repoKey);
    if (!match) return;

    // Re-publish the enriched message on the same topic.
    const enriched: BusMessage = {
      ...msg,
      id: crypto.randomUUID(),
      payload: {
        ...payload,
        projectSlug: match.projectSlug,
        discordChannels: match.discordChannels,
      },
    };

    bus.publish(msg.topic, enriched);
    console.log(`[a2a] Enriched ${repoKey} → project "${match.projectSlug}"`);
  }
}
