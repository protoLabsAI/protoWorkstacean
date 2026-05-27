/**
 * ProtomakerProjectRegistryPlugin — the source of truth for project metadata.
 *
 * Pulls the canonical project list from protoMaker
 * (`GET /api/settings/global` → `settings.projects[]: ProjectRef[]`) and
 * exposes it as the single, in-process registry that every workstacean
 * consumer reads from. `workspace/projects.yaml` no longer exists — this
 * plugin replaced it in #631 + the consumer refactor in this PR.
 *
 * protoMaker's `ProjectRef` is intentionally lean (id, name, path, UI prefs).
 * For workstacean's routing + cache needs we additionally derive:
 *
 *   - `slug`          — `name.toLowerCase().replace(/[^a-z0-9]+/g, "-")`
 *   - `github`        — `{ owner, repo }` from `<path>/.git/config` origin url
 *   - `defaultBranch` — from `<path>/.git/refs/remotes/origin/HEAD` symref
 *
 * If those fields ever land natively on `ProjectRef`, the derivation drops
 * to a fallback. See protoMaker#3883 for the native-field proposal.
 *
 * Startup contract: `refreshNow()` is exposed so the host (src/index.ts)
 * can `await` the first fetch before installing consumers. The 5-min
 * interval timer is started by `install()`.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Plugin, EventBus } from "../../lib/types.ts";

const DEFAULT_PROTOMAKER_BASE = "http://protomaker-server:3008";
const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;

export interface RegistryProject {
  /** ProjectRef.id from protoMaker. */
  id: string;
  /** ProjectRef.name from protoMaker (human-readable). */
  name: string;
  /** Topic-safe slug derived from name (lowercase, non-alphanum → "-"). */
  slug: string;
  /** Absolute filesystem path to the project directory (ProjectRef.path). */
  path: string;
  /** Derived from `<path>/.git/config` `[remote "origin"]` url. */
  github?: { owner: string; repo: string };
  /** Derived from `<path>/.git/refs/remotes/origin/HEAD` symref. */
  defaultBranch?: string;
}

export interface ProtomakerProjectRegistryOptions {
  /** protoMaker HTTP base URL. Default: `http://protomaker-server:3008`. */
  apiBase?: string;
  /** Refresh interval. Default: 5 min. */
  refreshIntervalMs?: number;
  /**
   * X-API-Key header value. protoMaker requires authentication on every
   * /api/* route — see protoMaker's `apps/server/src/lib/auth.ts`. The
   * variable is named `AUTOMAKER_API_KEY` because protoMaker calls its own
   * auth key that internally (legacy name); the host env in homelab-iac
   * threads it through unchanged. Without a key, every refresh 401s.
   */
  apiKey?: string;
}

export class ProtomakerProjectRegistryPlugin implements Plugin {
  readonly name = "protomaker-project-registry";
  readonly description =
    "Source of truth for project metadata — fetched from protoMaker, enriched with git origin/HEAD";
  readonly capabilities = ["project-registry"];

  private readonly apiBase: string;
  private readonly apiKey: string | undefined;
  private readonly refreshIntervalMs: number;

  private projects: RegistryProject[] = [];
  private refreshTimer?: ReturnType<typeof setInterval>;
  private lastRefreshAt = 0;
  private lastError: string | undefined;

  constructor(opts: ProtomakerProjectRegistryOptions = {}) {
    this.apiBase = opts.apiBase ?? process.env["PROTOMAKER_API_BASE"] ?? DEFAULT_PROTOMAKER_BASE;
    this.apiKey = opts.apiKey ?? process.env["AUTOMAKER_API_KEY"];
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  }

  install(_bus: EventBus): void {
    // Periodic background refresh. The first fetch is expected to have
    // already happened via `await registry.refreshNow()` in src/index.ts
    // before this plugin's consumers (router, github, clawpatch, …) are
    // installed. If the host didn't pre-fetch, consumers will see an empty
    // registry until the first interval tick — that's by design (the
    // host's responsibility), not silent fallback behaviour.
    this.refreshTimer = setInterval(() => void this._refresh(), this.refreshIntervalMs);
    if (!this.apiKey) {
      console.warn(
        `[protomaker-project-registry] AUTOMAKER_API_KEY not set — protoMaker will reject every refresh with 401. ` +
          `Set the env var (workstacean reads protoMaker's own auth key under that name) or pass apiKey in options.`,
      );
    }
    console.log(
      `[protomaker-project-registry] Installed — apiBase=${this.apiBase}, ` +
        `auth=${this.apiKey ? "configured" : "MISSING"}, ` +
        `refresh=${Math.round(this.refreshIntervalMs / 60_000)}min, ` +
        `${this.projects.length} project(s) loaded`,
    );
  }

  uninstall(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    this.projects = [];
  }

  /** Snapshot of currently-known projects. */
  getProjects(): readonly RegistryProject[] {
    return this.projects;
  }

  /** Lookup by derived slug. */
  getBySlug(slug: string): RegistryProject | undefined {
    return this.projects.find((p) => p.slug === slug);
  }

  /** Lookup by `owner/repo` string. */
  getByGithub(ownerRepo: string): RegistryProject | undefined {
    return this.projects.find(
      (p) => p.github && `${p.github.owner}/${p.github.repo}` === ownerRepo,
    );
  }

  /** Lookup by absolute filesystem path. */
  getByPath(path: string): RegistryProject | undefined {
    return this.projects.find((p) => p.path === path);
  }

  /** All known `owner/repo` coordinates (for monitored-repo lists / allowlists). */
  getGithubCoords(): string[] {
    return this.projects
      .filter((p) => p.github)
      .map((p) => `${p.github!.owner}/${p.github!.repo}`);
  }

  /** Last refresh timestamp (0 if never). */
  getLastRefreshAt(): number {
    return this.lastRefreshAt;
  }

  /** Last refresh error, if any. Cleared on next successful refresh. */
  getLastError(): string | undefined {
    return this.lastError;
  }

  /**
   * Force a synchronous-style refresh — used by the host at startup to
   * populate the registry before consumer plugins install. Surfaces fetch
   * errors via `getLastError()`; never throws (consumers can opt to fail
   * loud themselves if `getProjects().length === 0` is a startup blocker).
   */
  async refreshNow(): Promise<void> {
    await this._refresh();
  }

  private async _refresh(): Promise<void> {
    try {
      const raw = await this._fetchProjects();
      this.projects = raw.map((p) => this._enrichProject(p));
      this.lastRefreshAt = Date.now();
      this.lastError = undefined;
      console.log(
        `[protomaker-project-registry] Refreshed: ${this.projects.length} project(s) — ` +
          this.projects.map((p) => p.slug).join(", "),
      );
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
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
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

  private _enrichProject(p: { id: string; name: string; path: string }): RegistryProject {
    const enriched: RegistryProject = {
      id: p.id,
      name: p.name,
      slug: deriveSlug(p.name),
      path: p.path,
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
}

// ── Exported helpers (pure, testable) ────────────────────────────────────────

/**
 * Derive a topic-safe slug from a project name. Matches the slug shape
 * the old `workspace/projects.yaml` used (lowercase repo name with dots
 * replaced by dashes — e.g. `rabbit-hole.io` → `rabbit-hole-io`).
 */
export function deriveSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

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
  const match = headContent.trim().match(/^ref:\s*refs\/remotes\/origin\/(.+)$/);
  return match ? match[1]! : undefined;
}
