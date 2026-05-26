/**
 * ProtomakerProjectRegistryPlugin — pulls the canonical list of projects from
 * protoMaker (`GET /api/settings/global` → `settings.projects[]: ProjectRef[]`)
 * and exposes it as the source of truth for workstacean's project metadata.
 *
 * Phase 1 (this PR): the plugin runs in PARALLEL with `workspace/projects.yaml`.
 * Consumers still read from yaml; this plugin logs parity warnings between
 * the two sources so we get telemetry on drift before flipping. Phase 2 will
 * refactor the 13 consumer files to read from `getProjects()` instead, and
 * Phase 3 deletes `projects.yaml` + `lib/project-schema.ts`.
 *
 * protoMaker's `ProjectRef` is intentionally lean (id, name, path, UI prefs).
 * For workstacean's routing + cache needs we additionally derive:
 *
 *   - `github: { owner, repo }` — from `<path>/.git/config` `[remote "origin"]`
 *   - `defaultBranch`            — from `<path>/.git/refs/remotes/origin/HEAD`
 *
 * If those fields ever land natively on `ProjectRef`, the derivation drops
 * to a fallback. See protoMaker issue (filed alongside this PR) for the
 * native-field proposal.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Plugin, EventBus } from "../../lib/types.ts";

const DEFAULT_PROTOMAKER_BASE = "http://protomaker-server:3008";
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;

export interface RegistryProject {
  /** ProjectRef.id from protoMaker. */
  id: string;
  /** ProjectRef.name from protoMaker (human-readable). */
  name: string;
  /** Absolute filesystem path to the project directory (ProjectRef.path). */
  path: string;
  /** Derived from `<path>/.git/config` `[remote "origin"]` url. */
  github?: { owner: string; repo: string };
  /** Derived from `<path>/.git/refs/remotes/origin/HEAD` symref. */
  defaultBranch?: string;
  /** Provenance marker — distinguishes this from yaml-sourced records during parity logging. */
  source: "protomaker";
}

export interface ProtomakerProjectRegistryOptions {
  /** protoMaker HTTP base URL. Default: `http://protomaker-server:3008`. */
  apiBase?: string;
  /** Workspace directory (for parity check against projects.yaml). */
  workspaceDir: string;
  /** Refresh interval. Default: 5 min. */
  refreshIntervalMs?: number;
  /** When true, log parity warnings vs. workspace/projects.yaml on every refresh. */
  parityCheck?: boolean;
}

export class ProtomakerProjectRegistryPlugin implements Plugin {
  readonly name = "protomaker-project-registry";
  readonly description =
    "Fetches the canonical project list from protoMaker + derives git metadata; logs parity vs. projects.yaml";
  readonly capabilities = ["project-registry"];

  private readonly apiBase: string;
  private readonly workspaceDir: string;
  private readonly refreshIntervalMs: number;
  private readonly parityCheck: boolean;

  private projects: RegistryProject[] = [];
  private refreshTimer?: ReturnType<typeof setInterval>;
  private lastRefreshAt = 0;
  private lastError: string | undefined;

  constructor(opts: ProtomakerProjectRegistryOptions) {
    this.apiBase = opts.apiBase ?? process.env["PROTOMAKER_API_BASE"] ?? DEFAULT_PROTOMAKER_BASE;
    this.workspaceDir = opts.workspaceDir;
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.parityCheck = opts.parityCheck ?? true;
  }

  install(_bus: EventBus): void {
    // Fire-and-forget initial refresh — must not block install.
    void this._refresh();
    this.refreshTimer = setInterval(() => void this._refresh(), this.refreshIntervalMs);
    console.log(
      `[protomaker-project-registry] Installed — apiBase=${this.apiBase}, ` +
        `refresh=${Math.round(this.refreshIntervalMs / 60_000)}min, ` +
        `parityCheck=${this.parityCheck}`,
    );
  }

  uninstall(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.projects = [];
  }

  /** Snapshot of currently-known projects. Phase 2 consumers will read this. */
  getProjects(): readonly RegistryProject[] {
    return this.projects;
  }

  /** Last refresh timestamp (0 if never). */
  getLastRefreshAt(): number {
    return this.lastRefreshAt;
  }

  /** Last refresh error, if any. Cleared on next successful refresh. */
  getLastError(): string | undefined {
    return this.lastError;
  }

  private async _refresh(): Promise<void> {
    try {
      const raw = await this._fetchProjects();
      this.projects = raw.map((p) => this._enrichWithGit(p));
      this.lastRefreshAt = Date.now();
      this.lastError = undefined;
      console.log(
        `[protomaker-project-registry] Refreshed: ${this.projects.length} project(s) — ` +
          this.projects.map((p) => p.name).join(", "),
      );

      if (this.parityCheck) {
        this._logParityVsYaml();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      console.warn(
        `[protomaker-project-registry] Refresh failed (${this.apiBase}): ${msg} — ` +
          `keeping ${this.projects.length} stale project(s) in memory`,
      );
    }
  }

  /**
   * Fetch projects from protoMaker. Expected response shape:
   *   { success: true, settings: { projects: ProjectRef[] } }
   * Per protoMaker `apps/server/src/routes/settings/index.ts:14` (GET /global).
   */
  private async _fetchProjects(): Promise<Array<{ id: string; name: string; path: string }>> {
    const url = `${this.apiBase}/api/settings/global`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    const body = (await res.json()) as {
      success?: boolean;
      settings?: { projects?: Array<{ id: string; name: string; path: string }> };
    };
    if (!body.success) {
      throw new Error(`protoMaker returned success=false`);
    }
    return body.settings?.projects ?? [];
  }

  private _enrichWithGit(p: { id: string; name: string; path: string }): RegistryProject {
    const enriched: RegistryProject = {
      id: p.id,
      name: p.name,
      path: p.path,
      source: "protomaker",
    };
    const gitConfigPath = join(p.path, ".git", "config");
    if (existsSync(gitConfigPath)) {
      try {
        const config = readFileSync(gitConfigPath, "utf8");
        const github = parseGithubFromGitConfig(config);
        if (github) enriched.github = github;
      } catch {
        // Silent — non-essential enrichment.
      }
    }
    const headRefPath = join(p.path, ".git", "refs", "remotes", "origin", "HEAD");
    if (existsSync(headRefPath)) {
      try {
        const ref = readFileSync(headRefPath, "utf8").trim();
        const branch = parseDefaultBranchFromHead(ref);
        if (branch) enriched.defaultBranch = branch;
      } catch {
        // Silent — non-essential enrichment.
      }
    }
    return enriched;
  }

  /**
   * Compare protoMaker-sourced projects vs. workspace/projects.yaml.
   * Logs warnings for: extra projects on either side, github mismatches.
   * Purely observational — does not mutate either source.
   */
  private _logParityVsYaml(): void {
    const yamlPath = join(this.workspaceDir, "projects.yaml");
    if (!existsSync(yamlPath)) {
      // No yaml side to compare — nothing to log (yaml-less is the target state).
      return;
    }

    let yamlProjects: Array<{ slug: string; github?: string; path?: string }> = [];
    try {
      const parsed = parseYaml(readFileSync(yamlPath, "utf8")) as {
        projects?: Array<{ slug?: string; github?: string; projectPath?: string }>;
      };
      yamlProjects = (parsed.projects ?? [])
        .filter((p) => typeof p.slug === "string")
        .map((p) => ({ slug: p.slug as string, github: p.github, path: p.projectPath }));
    } catch (err) {
      console.warn(
        `[protomaker-project-registry] parity-check: failed to parse projects.yaml: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return;
    }

    const pmByPath = new Map(this.projects.map((p) => [p.path, p]));
    const yamlByPath = new Map(yamlProjects.filter((p) => p.path).map((p) => [p.path!, p]));

    const onlyInPm = this.projects.filter((p) => !yamlByPath.has(p.path));
    const onlyInYaml = yamlProjects.filter((p) => p.path && !pmByPath.has(p.path));

    if (onlyInPm.length > 0) {
      console.warn(
        `[protomaker-project-registry] parity: ${onlyInPm.length} project(s) only in protoMaker (not in projects.yaml) — ` +
          onlyInPm.map((p) => `${p.name}@${p.path}`).join(", "),
      );
    }
    if (onlyInYaml.length > 0) {
      console.warn(
        `[protomaker-project-registry] parity: ${onlyInYaml.length} project(s) only in projects.yaml (not in protoMaker) — ` +
          onlyInYaml.map((p) => `${p.slug}@${p.path}`).join(", "),
      );
    }

    // GitHub-field comparison for projects present on both sides.
    for (const [path, pm] of pmByPath) {
      const yaml = yamlByPath.get(path);
      if (!yaml) continue;
      const pmGithub = pm.github ? `${pm.github.owner}/${pm.github.repo}` : undefined;
      if (pmGithub && yaml.github && pmGithub !== yaml.github) {
        console.warn(
          `[protomaker-project-registry] parity: github mismatch for ${path} — ` +
            `protoMaker derived "${pmGithub}", yaml says "${yaml.github}"`,
        );
      }
    }
  }
}

// ── Exported helpers (pure, testable) ────────────────────────────────────────

/**
 * Parse the `[remote "origin"]` url from a git config file and extract
 * owner/repo. Supports SSH (`git@github.com:OWNER/REPO.git`), HTTPS
 * (`https://github.com/OWNER/REPO.git`), and `.git` suffix optional.
 * Returns undefined if no GitHub origin remote is found.
 */
export function parseGithubFromGitConfig(
  config: string,
): { owner: string; repo: string } | undefined {
  // Find the [remote "origin"] section's url line.
  // Sections are delimited by [...] headers; we look only inside the origin
  // section to avoid picking up a non-origin remote that happens to be GH.
  const lines = config.split("\n");
  let inOriginSection = false;
  let originUrl: string | undefined;
  for (const line of lines) {
    const sectionMatch = line.match(/^\s*\[(.+)\]\s*$/);
    if (sectionMatch) {
      inOriginSection = /remote\s+"origin"/.test(sectionMatch[1]!);
      continue;
    }
    if (!inOriginSection) continue;
    const urlMatch = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
    if (urlMatch) {
      originUrl = urlMatch[1]!;
      break;
    }
  }
  if (!originUrl) return undefined;

  // SSH: git@github.com:OWNER/REPO(.git)?
  const sshMatch = originUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1]!, repo: sshMatch[2]! };

  // HTTPS: https://github.com/OWNER/REPO(.git)?
  const httpsMatch = originUrl.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };

  return undefined;
}

/**
 * Parse `<path>/.git/refs/remotes/origin/HEAD` contents to extract the
 * default branch name. The file typically contains a symref like
 * `ref: refs/remotes/origin/main`.
 */
export function parseDefaultBranchFromHead(headContent: string): string | undefined {
  // Trim before matching — file usually ends with \n which the regex below
  // (no /m flag) won't cross because `.` doesn't match newline.
  const match = headContent.trim().match(/^ref:\s*refs\/remotes\/origin\/(.+)$/);
  return match ? match[1]! : undefined;
}
