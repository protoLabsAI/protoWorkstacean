/**
 * POST /api/clawpatch/review — structural code review via clawpatch.
 *
 * Wraps the `clawpatch ci --provider gateway --json` invocation behind an
 * HTTP endpoint so the LLM tool wrapper stays a thin caller and shell exec
 * is bounded to this route.
 *
 * Repo resolution
 * ---------------
 * The tool accepts `repo` in owner/name format. Resolution tries, in order:
 *
 *   1. `CLAWPATCH_REPO_PATH_MAP` env override (JSON owner/name → abs path)
 *      — dev-only escape hatch for pointing at a local working tree.
 *   2. Project-registry allowlist gate, then `CheckoutCache` — every other
 *      repo (including the ones that used to be bind-mounted) goes through
 *      the cache so Quinn always reviews the exact PR ref.
 *
 * No bind-mount fast path. Per C1 sign-off (#578): "better way over fast
 * way" — a single resolution code path means no "did Quinn review the
 * host's checkout or the PR head" ambiguity. See
 * docs/explanation/clawpatch-checkouts.md for the cache's eviction, TTL,
 * and security model.
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
  since?: string;
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
    console.warn("[clawpatch] CLAWPATCH_REPO_PATH_MAP is not valid JSON — ignoring");
    return null;
  }
  const path = overrides[repo];
  if (!path || !existsSync(path)) return null;
  return path;
}

/**
 * Lazy singleton — first review request after process start initializes it.
 * Test override via the `setCheckoutCacheForTesting` helper below.
 */
let _cache: CheckoutCache | null = null;
function getCheckoutCache(): CheckoutCache {
  if (_cache) return _cache;
  const auth = makeGitHubAuth();
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
 * Resolve a local filesystem path for clawpatch to operate on. One code
 * path, no bind-mount fast path: every repo (including protoWorkstacean
 * itself) routes through the GitHub-tarball cache so Quinn always reviews
 * the exact ref the PR is on, not whatever happens to be checked out on
 * the host. Per the C1 sign-off — "better way over fast way".
 *
 *   1. `CLAWPATCH_REPO_PATH_MAP` env override — dev-only escape hatch,
 *      lets a developer point clawpatch at a working tree.
 *   2. Project-registry allowlist gate — same security boundary as
 *      `create_github_issue`. Agents can't aim clawpatch at arbitrary
 *      GitHub repos.
 *   3. `CheckoutCache.resolve(repo, since)` — fetches the tarball at the
 *      given SHA, extracts under /data/checkouts/<owner>-<repo>/<sha>/,
 *      and returns the path. Content-addressed; 1h TTL.
 *
 * Returns `{ ok: false, error }` instead of throwing so the route handler
 * can shape a 400 response without a try/catch.
 */
async function resolveRepoPath(
  repo: string,
  since: string | undefined,
  projectRegistry: ProjectRegistry | undefined,
): Promise<{ ok: true; path: string } | { ok: false; error: string; status: number }> {
  const devOverride = resolveDevOverridePath(repo);
  if (devOverride) return { ok: true, path: devOverride };

  const allow = loadProjectAllowlist(projectRegistry);
  if (!allow.has(repo)) {
    return {
      ok: false,
      status: 400,
      error:
        `repo '${repo}' is not in the project registry — clawpatch only reviews ` +
        `managed projects. Register it in protoMaker first (or set CLAWPATCH_REPO_PATH_MAP for local dev).`,
    };
  }

  if (!since) {
    return {
      ok: false,
      status: 400,
      error:
        `clawpatch review needs 'since' (the PR head SHA) so the checkout ` +
        `cache can fetch the right ref from GitHub.`,
    };
  }

  try {
    const path = await getCheckoutCache().resolve(repo, since);
    return { ok: true, path };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, error: `checkout cache failed: ${msg}` };
  }
}

interface ClawpatchExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function runClawpatch(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<ClawpatchExecResult> {
  return new Promise((resolve) => {
    const child = spawn("clawpatch", args, {
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

export function createRoutes(ctx: ApiContext): Route[] {
  return [
    {
      method: "POST",
      path: "/api/clawpatch/review",
      handler: async (req) => {
        let payload: ReviewRequest;
        try {
          payload = (await req.json()) as ReviewRequest;
        } catch {
          return Response.json(
            { success: false, error: "Invalid JSON" },
            { status: 400 },
          );
        }
        const { repo, since, limit, model, provider } = payload;
        if (!repo) {
          return Response.json(
            { success: false, error: "repo is required" },
            { status: 400 },
          );
        }
        const resolution = await resolveRepoPath(repo, since, ctx.projectRegistry);
        if (!resolution.ok) {
          return Response.json(
            { success: false, error: resolution.error },
            { status: resolution.status },
          );
        }
        const repoPath = resolution.path;

        // Workstacean mounts repo source read-only, so push clawpatch state
        // into the writable data volume — one dir per owner/repo so we don't
        // re-map features for every PR review.
        const stateDir = stateDirFor(repo);
        const effectiveProvider = provider ?? "gateway";
        const args = [
          "ci",
          "--provider",
          effectiveProvider,
          "--json",
          "--state-dir",
          stateDir,
        ];
        if (since) args.push("--since", since);
        if (typeof limit === "number" && limit > 0)
          args.push("--limit", String(limit));
        if (model) args.push("--model", model);

        const result = await runClawpatch(args, repoPath, DEFAULT_TIMEOUT_MS);
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

        return Response.json({
          success: true,
          data: { repo, repoPath, ...parsed },
        });
      },
    },
  ];
}
