/**
 * ProjectRegistry — the source of truth for project metadata.
 *
 * A plain shared class (NOT a Plugin), in the same shape as ChannelRegistry /
 * ExecutorRegistry / IdentityRegistry: constructed once at startup and handed
 * to whichever plugins + routes need to read project metadata. Consumers hold
 * a reference to this *registry object*, not to another plugin — which is the
 * registrar exemption the plugin contract explicitly allows. (#633 review.)
 *
 * Pulls the canonical project list from protoMaker
 * (`GET /api/settings/global` → `settings.projects[]: ProjectRef[]`).
 * `workspace/projects.yaml` no longer exists — this replaced it in #631 + the
 * consumer refactor in this PR.
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
 * Startup contract: `refreshNow()` is awaited by the host (src/index.ts)
 * before consumers are constructed; `start()` then arms the 5-min refresh.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

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

/** A project as protoMaker returns it from `/api/settings/global`. `github` +
 *  `defaultBranch` are native ProjectRef fields (protoMaker#3883) — present for
 *  current protoMaker, optional so we can still derive from .git as a fallback. */
interface RawProtoMakerProject {
  id: string;
  name: string;
  path: string;
  github?: { owner: string; repo: string };
  defaultBranch?: string;
}

export interface ProjectRegistryOptions {
  /** protoMaker HTTP base URL. Default: `http://protomaker-server:3008`. */
  apiBase?: string;
  /** Refresh interval. Default: 5 min. */
  refreshIntervalMs?: number;
  /**
   * X-API-Key header value. protoMaker requires authentication on every
   * /api/* route — see protoMaker's `apps/server/src/lib/auth.ts`. The
   * variable is named `AUTOMAKER_API_KEY` because that's protoMaker's own
   * server-side auth-key env (legacy name from before the Automaker →
   * protoMaker rename); the host env in homelab-iac threads it through
   * unchanged. Without a key, every refresh 401s.
   */
  apiKey?: string;
}

export class ProjectRegistry {
  private readonly apiBase: string;
  private readonly apiKey: string | undefined;
  private readonly refreshIntervalMs: number;

  private projects: RegistryProject[] = [];
  private refreshTimer?: ReturnType<typeof setInterval>;
  private lastRefreshAt = 0;
  private lastError: string | undefined;

  constructor(opts: ProjectRegistryOptions = {}) {
    this.apiBase = opts.apiBase ?? process.env["PROTOMAKER_API_BASE"] ?? DEFAULT_PROTOMAKER_BASE;
    this.apiKey = opts.apiKey ?? process.env["AUTOMAKER_API_KEY"];
    this.refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
  }

  /**
   * Arm the periodic background refresh. The first fetch is expected to have
   * already happened via `await registry.refreshNow()` before consumers read
   * the registry — `start()` only schedules subsequent refreshes.
   */
  start(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => void this._refresh(), this.refreshIntervalMs);
    if (!this.apiKey) {
      console.warn(
        `[project-registry] AUTOMAKER_API_KEY not set — protoMaker will reject every refresh with 401. ` +
          `Set the env var (workstacean reads protoMaker's own auth key under that name) or pass apiKey in options.`,
      );
    }
    console.log(
      `[project-registry] Started — apiBase=${this.apiBase}, ` +
        `auth=${this.apiKey ? "configured" : "MISSING"}, ` +
        `refresh=${Math.round(this.refreshIntervalMs / 60_000)}min, ` +
        `${this.projects.length} project(s) loaded`,
    );
  }

  stop(): void {
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

  /** Lookup by `owner/repo` string (case-insensitive — GitHub coords are). */
  getByGithub(ownerRepo: string): RegistryProject | undefined {
    const needle = ownerRepo.toLowerCase();
    return this.projects.find(
      (p) => p.github && `${p.github.owner}/${p.github.repo}`.toLowerCase() === needle,
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
   * populate the registry before consumers read it. Surfaces fetch errors
   * via `getLastError()`; never throws.
   */
  async refreshNow(): Promise<void> {
    await this._refresh();
  }

  private async _refresh(): Promise<void> {
    try {
      const raw = await this._fetchProjects();
      this.projects = dedupeBySlug(raw.map((p) => this._enrichProject(p)));
      this.lastRefreshAt = Date.now();
      this.lastError = undefined;
      console.log(
        `[project-registry] Refreshed: ${this.projects.length} project(s) — ` +
          this.projects.map((p) => p.slug).join(", "),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      console.warn(
        `[project-registry] Refresh failed (${this.apiBase}): ${msg} — ` +
          `keeping ${this.projects.length} stale project(s) in memory`,
      );
    }
  }

  /**
   * Fetch projects from protoMaker. Expected response shape:
   *   { success: true, settings: { projects: ProjectRef[] } }
   * Per protoMaker `apps/server/src/routes/settings/index.ts:14` (GET /global).
   */
  private async _fetchProjects(): Promise<RawProtoMakerProject[]> {
    const url = `${this.apiBase}/api/settings/global`;
    const headers: Record<string, string> = {};
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${url}`);
    }
    const body = (await res.json()) as {
      success?: boolean;
      settings?: { projects?: RawProtoMakerProject[] };
    };
    if (!body.success) {
      throw new Error(`protoMaker returned success=false`);
    }
    return body.settings?.projects ?? [];
  }

  private _enrichProject(p: RawProtoMakerProject): RegistryProject {
    const enriched: RegistryProject = {
      id: p.id,
      name: p.name,
      slug: deriveSlug(p.name),
      path: p.path,
    };

    // Prefer protoMaker's native github/defaultBranch (ProjectRef, protoMaker#3883).
    // It's the source of truth and survives GitHub repo renames — deriving from
    // the local clone's .git/config drifts on rename (e.g. contentMachine →
    // protoContent silently broke board routing until the remote was re-pointed).
    // Fall back to .git derivation only when protoMaker omits the field.
    if (p.github?.owner && p.github?.repo) {
      enriched.github = { owner: p.github.owner, repo: p.github.repo };
    } else {
      const gitConfigPath = join(p.path, ".git", "config");
      if (existsSync(gitConfigPath)) {
        try {
          const github = parseGithubFromGitConfig(readFileSync(gitConfigPath, "utf8"));
          if (github) enriched.github = github;
        } catch {
          // Silent — non-essential enrichment.
        }
      }
    }

    if (p.defaultBranch) {
      enriched.defaultBranch = p.defaultBranch;
    } else {
      const headRefPath = join(p.path, ".git", "refs", "remotes", "origin", "HEAD");
      if (existsSync(headRefPath)) {
        try {
          const branch = parseDefaultBranchFromHead(readFileSync(headRefPath, "utf8").trim());
          if (branch) enriched.defaultBranch = branch;
        } catch {
          // Silent — non-essential enrichment.
        }
      }
    }

    return enriched;
  }
}

// ── Exported helpers (pure, testable) ────────────────────────────────────────

/**
 * Drop projects whose derived slug collides with an earlier one — `getBySlug`
 * must be deterministic, and a collision would make project-channel resolution
 * silently pick whichever entry happened to sort first. Keep the first
 * occurrence and warn loudly so the operator can rename one in protoMaker.
 */
export function dedupeBySlug(projects: RegistryProject[]): RegistryProject[] {
  const seen = new Set<string>();
  const out: RegistryProject[] = [];
  for (const p of projects) {
    if (seen.has(p.slug)) {
      console.warn(
        `[project-registry] duplicate slug "${p.slug}" — keeping the first project, ` +
          `dropping "${p.name}" (${p.path}). Rename one in protoMaker to disambiguate.`,
      );
      continue;
    }
    seen.add(p.slug);
    out.push(p);
  }
  return out;
}

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

  const sshMatch = originUrl.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1]!, repo: sshMatch[2]! };

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
