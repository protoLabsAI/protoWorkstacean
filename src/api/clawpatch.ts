/**
 * POST /api/clawpatch/review — structural code review via clawpatch.
 *
 * Wraps the `clawpatch ci --provider gateway --json` invocation behind an
 * HTTP endpoint so the LLM tool wrapper stays a thin caller and shell exec
 * is bounded to this route.
 *
 * PR resolution
 * -------------
 * The tool accepts `repo` (owner/name) + `pr` (number). The route resolves
 * the PR's `head.sha` (the tree to review) and `base.sha` (the ref to diff
 * against) from GitHub itself — the caller never passes SHAs, so an agent
 * can't strand the review on a hallucinated ref. Then:
 *
 *   1. `CLAWPATCH_REPO_PATH_MAP` env override (JSON owner/name → abs path)
 *      — dev-only escape hatch for pointing at a local working tree.
 *   2. Project-registry allowlist gate, then `CheckoutCache.resolve(repo,
 *      headSha)` — a git checkout at the PR head with base reachable.
 *
 * clawpatch runs `ci --since <base.sha>` inside that checkout, so it scopes
 * the review to exactly the features the PR touched (not the whole repo).
 * Reviewing the head diffed against the base is what makes the findings
 * relevant; a whole-tree review both over-reports and blows the model's
 * per-feature time budget. See docs/explanation/clawpatch-checkouts.md for
 * the cache's eviction, TTL, and security model.
 *
 * Env
 * ---
 *   CLAWPATCH_REPO_PATH_MAP    JSON string mapping owner/name → absolute
 *                              path inside the container. Overrides built-in.
 *   CLAWPATCH_GATEWAY_MODEL    Forwarded to clawpatch (default protolabs/smart)
 *   OPENAI_API_KEY / OPENAI_BASE_URL  Already set in the container env;
 *                              clawpatch's gateway provider picks them up.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CheckoutCache } from "../../lib/checkout-cache.ts";
import { makeGitHubAuth } from "../../lib/github-auth.ts";
import type { Route, ApiContext } from "./types.ts";
import type { ProjectRegistry } from "../plugins/project-registry.ts";
import { safeKeyEqual } from "../../lib/runtime-env.ts";
import { logger } from "../../lib/log.ts";

const log = logger("clawpatch");

/**
 * Where clawpatch persists `.clawpatch/` (features, findings, runs, reports,
 * etc.). Repo mounts in the workstacean container are read-only, so we put
 * state in the workstacean-data volume — one subdirectory per owner/repo.
 *
 * Override with CLAWPATCH_STATE_ROOT for testing or when DATA_DIR isn't set.
 */
const CLAWPATCH_STATE_ROOT =
  process.env["CLAWPATCH_STATE_ROOT"] ??
  join(process.env["DATA_DIR"] ?? "/data", "clawpatch");

function stateDirFor(repo: string): string {
  // owner/repo → owner-repo so the path stays one level deep.
  const slug = repo.replace("/", "-");
  const dir = join(CLAWPATCH_STATE_ROOT, slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface ReviewRequest {
  repo: string;
  /** PR number. The route resolves head + base SHAs from GitHub. */
  pr: number;
  limit?: number;
  /** Override the model for this invocation. Defaults to the provider's default. */
  model?: string;
  /**
   * Which protoPatch provider to use. `gateway` (default) sends an
   * already-assembled prompt to the LiteLLM endpoint — fast/cheap/stateless,
   * good for nearly every PR. `proto` spawns protoCLI as a live ACP agent
   * so it can read additional files, run LSP queries, and shell out during
   * review — slower + more tokens but deeper structural read on non-trivial
   * changes. Other valid values: claude, codex, acpx — these need the
   * respective CLI installed and OAuth'd inside the container, which we
   * don't bootstrap today.
   */
  provider?: "gateway" | "proto" | "claude" | "codex" | "acpx";
}

/**
 * Read the dev-only `CLAWPATCH_REPO_PATH_MAP` override, if set. Lets a
 * developer point clawpatch at a working tree on disk instead of going
 * through the GitHub-tarball cache — handy when iterating on protoPatch
 * itself, or when reviewing a local-only branch that GitHub doesn't have
 * a ref for. Production never sets this; everything routes through the
 * cache so Quinn reviews the exact ref the PR is on.
 */
function resolveDevOverridePath(repo: string): string | null {
  const raw = process.env["CLAWPATCH_REPO_PATH_MAP"];
  if (!raw) return null;
  let overrides: Record<string, string>;
  try {
    overrides = JSON.parse(raw) as Record<string, string>;
  } catch {
    // Bad JSON shouldn't break the route — log once and fall through to cache.
    log.warn("CLAWPATCH_REPO_PATH_MAP is not valid JSON — ignoring");
    return null;
  }
  const path = overrides[repo];
  if (!path || !existsSync(path)) return null;
  return path;
}

/**
 * Memoized GitHub auth. `makeGitHubAuth()` builds a fresh `GitHubAppAuth`
 * whose installation-token cache lives on the instance — calling it per
 * request would re-mint a JWT + installation token every review. Memoize the
 * getter so the token cache persists. Lazy (not a module const) because
 * `makeGitHubAuth()` throws on partial App config; deferring that to first use
 * keeps it out of import time and lets `resolvePrRefs` surface it as a clean
 * error response.
 */
let _githubAuth: ((owner: string, repo: string) => Promise<string>) | null | undefined;
function githubAuth(): ((owner: string, repo: string) => Promise<string>) | null {
  if (_githubAuth === undefined) _githubAuth = makeGitHubAuth();
  return _githubAuth;
}

/**
 * Lazy singleton — first review request after process start initializes it.
 * Test override via the `setCheckoutCacheForTesting` helper below.
 */
let _cache: CheckoutCache | null = null;
function getCheckoutCache(): CheckoutCache {
  if (_cache) return _cache;
  const auth = githubAuth();
  _cache = new CheckoutCache({
    getToken: auth ?? undefined,
  });
  return _cache;
}

export function setCheckoutCacheForTesting(cache: CheckoutCache | null): void {
  _cache = cache;
}

/**
 * Load the set of repos allowed for clawpatch review from the project
 * registry. Same allowlist boundary that `create_github_issue` enforces —
 * agents can't point clawpatch at arbitrary GitHub repos.
 */
function loadProjectAllowlist(
  projectRegistry: ProjectRegistry | undefined,
): Set<string> {
  return new Set(projectRegistry?.getGithubCoords() ?? []);
}

/**
 * Resolve the PR's head + base SHAs from GitHub. `head` is the tree
 * clawpatch reviews; `base` is the ref it diffs against (`--since`).
 * Resolving server-side — rather than trusting caller-supplied SHAs — keeps
 * an agent from stranding the review on a hallucinated ref, and is the only
 * way the route knows which tree to check out.
 *
 * Returns `{ ok: false, error, status }` instead of throwing so the handler
 * can shape the response without a try/catch.
 */
async function resolvePrRefs(
  owner: string,
  name: string,
  pr: number,
): Promise<
  | { ok: true; headSha: string; baseSha: string }
  | { ok: false; error: string; status: number }
> {
  let getToken: ((owner: string, repo: string) => Promise<string>) | null;
  try {
    getToken = githubAuth();
  } catch (err) {
    // Partial App config throws here — surface it as a clean error, not a 500.
    return { ok: false, status: 500, error: err instanceof Error ? err.message : String(err) };
  }
  if (!getToken) {
    return {
      ok: false,
      status: 500,
      error: "no GitHub credentials (GITHUB_APP_* or GITHUB_TOKEN) to resolve the PR",
    };
  }
  try {
    const token = await getToken(owner, name);
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${name}/pulls/${pr}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "protoquinn-clawpatch",
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        status: resp.status === 404 ? 404 : 502,
        error: `GitHub PR ${owner}/${name}#${pr} lookup failed: ${resp.status} ${body.slice(0, 200)}`,
      };
    }
    const prData = (await resp.json()) as {
      head?: { sha?: string };
      base?: { sha?: string };
    };
    const headSha = prData.head?.sha;
    const baseSha = prData.base?.sha;
    if (!headSha || !baseSha) {
      return {
        ok: false,
        status: 502,
        error: `GitHub PR ${owner}/${name}#${pr} returned no head/base SHA`,
      };
    }
    return { ok: true, headSha, baseSha };
  } catch (err) {
    // Network failure, auth throw, or the 15s AbortSignal firing — fail clean.
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, error: `GitHub PR ${owner}/${name}#${pr} lookup errored: ${msg}` };
  }
}

/**
 * Gate repo access — the security boundary, and it MUST run before any GitHub
 * call so an unmanaged `owner/name` can't trigger a PR lookup on the bot's
 * credentials (which would leak head/base SHA metadata for repos we don't
 * manage). Same boundary `create_github_issue` checks.
 *
 *   - `CLAWPATCH_REPO_PATH_MAP` env override — dev-only escape hatch that
 *     points clawpatch at a local working tree; bypasses the allowlist.
 *   - Otherwise the repo must be in the project registry.
 *
 * Returns the dev-override path (if any) so the handler can skip the cache.
 */
function gateRepoAccess(
  repo: string,
  projectRegistry: ProjectRegistry | undefined,
): { ok: true; devPath: string | null } | { ok: false; error: string; status: number } {
  const devOverride = resolveDevOverridePath(repo);
  if (devOverride) return { ok: true, devPath: devOverride };

  const allow = loadProjectAllowlist(projectRegistry);
  if (!allow.has(repo)) {
    return {
      ok: false,
      status: 400,
      error:
        `repo '${repo}' is not in the project registry — clawpatch only reviews ` +
        `managed projects. Register it by tagging the repo with the \`protoagent-plugin\` topic (or set CLAWPATCH_REPO_PATH_MAP for local dev).`,
    };
  }
  return { ok: true, devPath: null };
}

interface ClawpatchExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function runCommand(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ClawpatchExecResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), exitCode: -1, timedOut });
    });
  });
}

interface CiJsonOutput {
  run?: string;
  reviewed?: number;
  findings?: number;
  jobs?: number;
  errors?: Array<{ feature?: string; message?: string; layer?: string }>;
  report?: string;
  items?: unknown[];
}

/** A finding as returned to the reviewing agent — the lean, foldable shape. */
export interface ClawpatchFinding {
  id: string;
  title: string;
  severity: string;
  category: string;
  confidence: string;
  evidence: Array<{ path: string; startLine?: number; endLine?: number }>;
  recommendation: string;
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const CONFIDENCE_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Max findings returned per review — keeps the tool result inside a sane token budget. */
export const PR_FINDINGS_CAP = 20;

/**
 * Select the findings the reviewing agent should actually see: open findings
 * whose evidence touches a file this PR changed (state accumulates across
 * PRs — unrelated findings are noise on this review), highest severity then
 * confidence first, capped.
 */
export function selectPrFindings(
  items: unknown[],
  changedPaths: string[],
  cap: number = PR_FINDINGS_CAP,
): ClawpatchFinding[] {
  const changed = new Set(changedPaths);
  const findings: ClawpatchFinding[] = [];
  for (const raw of items) {
    const it = raw as Record<string, unknown>;
    if (typeof it?.id !== "string" || typeof it?.title !== "string") continue;
    const evidence = (Array.isArray(it.evidence) ? it.evidence : [])
      .map((e) => e as Record<string, unknown>)
      .filter((e) => typeof e?.path === "string")
      .map((e) => ({
        path: e.path as string,
        ...(typeof e.startLine === "number" ? { startLine: e.startLine } : {}),
        ...(typeof e.endLine === "number" ? { endLine: e.endLine } : {}),
      }));
    if (!evidence.some((e) => changed.has(e.path))) continue;
    findings.push({
      id: it.id,
      title: it.title,
      severity: typeof it.severity === "string" ? it.severity : "unknown",
      category: typeof it.category === "string" ? it.category : "unknown",
      confidence: typeof it.confidence === "string" ? it.confidence : "unknown",
      evidence,
      recommendation: typeof it.recommendation === "string" ? it.recommendation : "",
    });
  }
  findings.sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) ||
      (CONFIDENCE_RANK[a.confidence] ?? 9) - (CONFIDENCE_RANK[b.confidence] ?? 9),
  );
  return findings.slice(0, cap);
}

export function createRoutes(ctx: ApiContext): Route[] {
  return [
    {
      method: "POST",
      path: "/api/clawpatch/review",
      handler: async (req) => {
        // Auth: this spawns an LLM-backed review (cost + compute). Gate it like
        // the other write routes — admin key required (fail-closed in prod via
        // the startup guard). (#791)
        if (ctx.apiKey) {
          const bearer = req.headers.get("Authorization");
          const provided = req.headers.get("X-API-Key") ?? (bearer?.startsWith("Bearer ") ? bearer.slice(7) : null);
          if (!safeKeyEqual(provided, ctx.apiKey)) {
            return Response.json({ success: false, error: "Unauthorized" }, { status: 401 });
          }
        }
        let payload: ReviewRequest;
        try {
          payload = (await req.json()) as ReviewRequest;
        } catch {
          return Response.json(
            { success: false, error: "Invalid JSON" },
            { status: 400 },
          );
        }
        const { repo, pr, limit, model, provider } = payload;
        if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
          return Response.json(
            { success: false, error: "repo is required in owner/name format" },
            { status: 400 },
          );
        }
        if (typeof pr !== "number" || !Number.isInteger(pr) || pr <= 0) {
          return Response.json(
            { success: false, error: "pr (positive integer PR number) is required" },
            { status: 400 },
          );
        }
        const [owner, name] = repo.split("/");

        // Allowlist gate FIRST — before any GitHub call — so an unmanaged repo
        // can't trigger a PR lookup on the bot's credentials.
        const gate = gateRepoAccess(repo, ctx.projectRegistry);
        if (!gate.ok) {
          return Response.json(
            { success: false, error: gate.error },
            { status: gate.status },
          );
        }

        // Resolve head + base from the PR itself — the caller never passes
        // SHAs, so the review can't strand on a hallucinated ref.
        const refs = await resolvePrRefs(owner, name, pr);
        if (!refs.ok) {
          return Response.json(
            { success: false, error: refs.error },
            { status: refs.status },
          );
        }

        let repoPath: string;
        if (gate.devPath) {
          repoPath = gate.devPath;
        } else {
          try {
            repoPath = await getCheckoutCache().resolve(repo, refs.headSha);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return Response.json(
              { success: false, error: `checkout failed: ${msg}` },
              { status: 502 },
            );
          }
        }

        // clawpatch writes `.clawpatch/` state; the checkout tree is transient
        // (TTL-evicted), so keep state in the writable data volume — one dir
        // per owner/repo so we don't re-map features for every PR review.
        const stateDir = stateDirFor(repo);
        const effectiveProvider = provider ?? "gateway";
        // Diff the head against the PR base so the review is scoped to exactly
        // the features the PR touched, not the whole repo.
        const args = [
          "ci",
          "--provider",
          effectiveProvider,
          "--json",
          "--state-dir",
          stateDir,
          "--since",
          refs.baseSha,
        ];
        if (typeof limit === "number" && limit > 0)
          args.push("--limit", String(limit));
        if (model) args.push("--model", model);

        const result = await runCommand("clawpatch", args, repoPath, DEFAULT_TIMEOUT_MS);
        if (result.timedOut) {
          return Response.json(
            {
              success: false,
              error: `clawpatch timed out after ${DEFAULT_TIMEOUT_MS}ms`,
            },
            { status: 504 },
          );
        }
        if (result.exitCode !== 0) {
          return Response.json(
            {
              success: false,
              error: `clawpatch exited ${result.exitCode}: ${result.stderr.slice(0, 1000) || result.stdout.slice(0, 1000)}`,
            },
            { status: 500 },
          );
        }

        // `clawpatch ci --json` writes a JSON object to stdout. The schema is
        // documented in protoPatch/src/cli.ts; we treat it loosely here because
        // schema drift would otherwise block working reviews.
        let parsed: CiJsonOutput;
        try {
          parsed = JSON.parse(result.stdout) as CiJsonOutput;
        } catch (err) {
          return Response.json(
            {
              success: false,
              error: `clawpatch returned non-JSON on stdout: ${String(err).slice(0, 300)}; preview=${result.stdout.slice(0, 300)}`,
            },
            { status: 500 },
          );
        }

        // The ci JSON carries COUNTS only — the finding bodies live in the
        // state dir, so a reviewer calling this tool was told "findings: 3"
        // and nothing else (ws-91a: 61% structural call rate, but only 20% of
        // finding-bearing runs left any trace in the review — the pipe was
        // broken, not the prompt). Attach the open findings scoped to the
        // files this PR actually changed, so the agent can fold them.
        let prFindings: ClawpatchFinding[] = [];
        let findingsError: string | undefined;
        try {
          const diff = await runCommand(
            "git",
            ["diff", "--name-only", refs.baseSha, refs.headSha],
            repoPath,
            30_000,
          );
          if (diff.exitCode !== 0) throw new Error(`git diff exited ${diff.exitCode}: ${diff.stderr.slice(0, 200)}`);
          const changedPaths = diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
          const rep = await runCommand(
            "clawpatch",
            ["report", "--state-dir", stateDir, "--status", "open", "--json"],
            repoPath,
            30_000,
          );
          if (rep.exitCode !== 0) throw new Error(`report exited ${rep.exitCode}: ${rep.stderr.slice(0, 200)}`);
          const repParsed = JSON.parse(rep.stdout) as { items?: unknown[] };
          prFindings = selectPrFindings(repParsed.items ?? [], changedPaths);
        } catch (err) {
          // Fail loud in the response (the agent records it as a Gap), but a
          // findings-fetch failure must not fail a completed review run.
          findingsError = err instanceof Error ? err.message : String(err);
          log.warn(`PR-scoped findings fetch failed for ${repo}#${pr}`, { err });
        }

        return Response.json({
          success: true,
          data: {
            repo,
            pr,
            head: refs.headSha,
            base: refs.baseSha,
            repoPath,
            ...parsed,
            prFindings,
            ...(findingsError ? { findingsError } : {}),
          },
        });
      },
    },
  ];
}
