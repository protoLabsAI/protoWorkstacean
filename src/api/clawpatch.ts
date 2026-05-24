/**
 * POST /api/clawpatch/review — structural code review via clawpatch.
 *
 * Wraps the `clawpatch ci --provider gateway --json` invocation behind an
 * HTTP endpoint so the LLM tool wrapper stays a thin caller and shell exec
 * is bounded to this route.
 *
 * Repo resolution
 * ---------------
 * The tool accepts `repo` in owner/name format. We map it to a local
 * filesystem path via `CLAWPATCH_REPO_PATH_MAP` (JSON env override) or a
 * built-in default that knows about repos mounted into the workstacean
 * container today. v1 only supports already-mounted repos; on-demand PR
 * checkouts are phase 2.
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
import type { Route, ApiContext } from "./types.ts";

/**
 * Where clawpatch persists `.clawpatch/` (features, findings, runs, reports,
 * etc.). Repo mounts in the workstacean container are read-only, so we put
 * state in the workstacean-data volume — one subdirectory per owner/repo.
 *
 * Override with CLAWPATCH_STATE_ROOT for testing or when DATA_DIR isn't set.
 */
const CLAWPATCH_STATE_ROOT =
  process.env["CLAWPATCH_STATE_ROOT"]
  ?? join(process.env["DATA_DIR"] ?? "/data", "clawpatch");

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
  /** Override the model for this invocation. Defaults to the gateway provider's default. */
  model?: string;
}

const BUILT_IN_REPO_PATHS: Record<string, string> = {
  // Repos mounted read-only into the workstacean container today (see
  // homelab-iac/stacks/ai/docker-compose.yml workstacean.volumes).
  "protoLabsAI/protoWorkstacean": "/home/josh/dev/protoWorkstacean",
  "protoLabsAI/protoCLI": "/home/josh/dev/labs/protoCLI",
  "protoLabsAI/mythxengine": "/home/josh/dev/labs/mythxengine",
};

function resolveRepoPath(repo: string): string | null {
  let overrides: Record<string, string> = {};
  const raw = process.env["CLAWPATCH_REPO_PATH_MAP"];
  if (raw) {
    try {
      overrides = JSON.parse(raw) as Record<string, string>;
    } catch {
      // Fall through with empty overrides — bad JSON shouldn't break the route.
    }
  }
  const path = overrides[repo] ?? BUILT_IN_REPO_PATHS[repo];
  if (!path) return null;
  if (!existsSync(path)) return null;
  return path;
}

interface ClawpatchExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function runClawpatch(args: string[], cwd: string, timeoutMs: number): Promise<ClawpatchExecResult> {
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
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
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

export function createRoutes(_ctx: ApiContext): Route[] {
  return [
    {
      method: "POST",
      path: "/api/clawpatch/review",
      handler: async (req) => {
        let payload: ReviewRequest;
        try {
          payload = (await req.json()) as ReviewRequest;
        } catch {
          return Response.json({ success: false, error: "Invalid JSON" }, { status: 400 });
        }
        const { repo, since, limit, model } = payload;
        if (!repo) {
          return Response.json({ success: false, error: "repo is required" }, { status: 400 });
        }
        const repoPath = resolveRepoPath(repo);
        if (!repoPath) {
          return Response.json(
            {
              success: false,
              error: `repo '${repo}' is not mounted in this container — only repos in CLAWPATCH_REPO_PATH_MAP / the built-in mounts (protoWorkstacean, protoCLI, mythxengine) work today. On-demand PR checkouts are not implemented.`,
            },
            { status: 400 },
          );
        }

        // Workstacean mounts repo source read-only, so push clawpatch state
        // into the writable data volume — one dir per owner/repo so we don't
        // re-map features for every PR review.
        const stateDir = stateDirFor(repo);
        const args = ["ci", "--provider", "gateway", "--json", "--state-dir", stateDir];
        if (since) args.push("--since", since);
        if (typeof limit === "number" && limit > 0) args.push("--limit", String(limit));
        if (model) args.push("--model", model);

        const result = await runClawpatch(args, repoPath, DEFAULT_TIMEOUT_MS);
        if (result.timedOut) {
          return Response.json(
            { success: false, error: `clawpatch timed out after ${DEFAULT_TIMEOUT_MS}ms` },
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

        return Response.json({ success: true, data: { repo, repoPath, ...parsed } });
      },
    },
  ];
}
