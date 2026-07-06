/**
 * TODO(refactor): This file is 664 lines mixing webhook handling + auto-triage
 * + auth (GitHub App vs PAT). When next touching, consider splitting:
 *   lib/plugins/github/webhook.ts — webhook signature verification + routing
 *   lib/plugins/github/auto-triage.ts — issue auto-triage logic
 *   lib/plugins/github/auth.ts — App vs PAT auth selection
 *   lib/plugins/github.ts — plugin shell
 *
 * GitHubPlugin — receives GitHub webhook events and routes @mentions to the bus.
 *
 * Inbound:
 *   POST /webhook/github → validates signature → filters for @mentions
 *   → message.inbound.github.{owner}.{repo}.{event}.{number}
 *
 * Outbound:
 *   message.outbound.github.# → posts GitHub comment via API
 *
 * Config: workspace/github.yaml (mention handle, skill hints per event type)
 *
 * Auth (in priority order):
 *   GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY   GitHub App — comments post as quinn[bot]
 *   GITHUB_TOKEN                           PAT fallback
 *
 * Other env vars:
 *   GITHUB_WEBHOOK_SECRET   validates X-Hub-Signature-256 (recommended)
 *   GITHUB_WEBHOOK_PORT     webhook HTTP server port (default: 8082)
 */

import { readFileSync, existsSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { EventBus, BusMessage, Plugin } from "../types.ts";
import { makeGitHubAuth } from "../github-auth.ts";
import { logger } from "../log.ts";
import { isProductionLike } from "../runtime-env.ts";
import { getFleetConfig } from "../fleet/fleet-config.ts";
import { withCircuitBreaker } from "./circuit-breaker.ts";
import type { ProjectRegistry } from "../../src/plugins/project-registry.ts";
import type { ReleasePublishedPayload } from "../../src/event-bus/payloads.ts";
import { handlePRMerge, parsePRMergePayload } from "../../src/webhooks/github-pr-merge.ts";
import { GitHubReviewSubmitter } from "../../src/github/reviewSubmitter.ts";
import {
  handleCommentResponse,
  handleReviewDismissal,
  type ReviewCommentPayload,
  type ReviewDismissalPayload,
} from "../../src/webhooks/github-comment-response.ts";

const log = logger("github");

// ── Config types ──────────────────────────────────────────────────────────────

interface GitHubConfig {
  mentionHandle: string;
  skillHints: Record<string, string>;
  admins?: string[];
}

/**
 * Logins we treat as "our own agent bots" — events authored by these
 * accounts are dropped from auto-triage and @mention paths to prevent
 * self-cascades (Quinn files an issue → webhook → triage → Quinn files
 * another issue → ...). See protoWorkstacean#556 for the original 23-
 * issue cascade that surfaced this.
 *
 * The default set covers the App identities + their bare-handle aliases
 * (GitHub sometimes returns `quinn` vs `quinn[bot]` depending on the
 * payload path). Override the full set via env:
 *
 *   WORKSTACEAN_AGENT_BOT_LOGINS=protoquinn[bot],protoquinn,ava[bot],ava,foo[bot]
 *
 * Auto-review (pull_request opened/synchronize → Quinn) is intentionally
 * NOT filtered — @protoquinn[bot] opens PRs and those should still be
 * reviewed; self-approval is already guarded by GitHub itself.
 */
const DEFAULT_AGENT_BOT_LOGINS = [
  "protoquinn",
  "protoquinn[bot]",
  "ava",
  "ava[bot]",
  "protobot",
  "protobot[bot]",
];

function agentBotLogins(): Set<string> {
  const raw = process.env["WORKSTACEAN_AGENT_BOT_LOGINS"];
  const list = raw
    ? raw.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_AGENT_BOT_LOGINS;
  return new Set(list.map((s) => s.toLowerCase()));
}

export function isAgentBotActor(login: string | undefined | null): boolean {
  if (!login) return false;
  return agentBotLogins().has(login.toLowerCase());
}

/**
 * Login bases (lowercased, trailing "[bot]" stripped) that identify the
 * reviewer agent's OWN GitHub reviews — config-driven via `fleet.yaml`'s
 * `github.reviewerBotLogins` (default `protoquinn`), so a fork's reviewer bot
 * is matched by the review loop instead of the hardcoded `protoquinn`. (#798)
 */
function reviewerLoginBases(): string[] {
  return [...new Set(getFleetConfig().reviewerBotLogins.map((l) => l.toLowerCase().replace(/\[bot\]$/, "")))];
}

function loadConfig(workspaceDir: string): GitHubConfig {
  const configPath = join(workspaceDir, "github.yaml");
  let config: GitHubConfig;

  if (!existsSync(configPath)) {
    config = {
      mentionHandle: "@protoquinn",
      skillHints: {
        issue_comment: "bug_triage",
        issues: "bug_triage",
        pull_request_review_comment: "pr_review",
        pull_request: "pr_review",
      },
    };
  } else {
    config = parseYaml(readFileSync(configPath, "utf8")) as GitHubConfig;
  }

  return config;
}

// ── Pending comment context ───────────────────────────────────────────────────

interface PendingComment {
  owner: string;
  repo: string;
  number: number;
}

const pendingComments = new Map<string, PendingComment>();

// ── GitHub event helpers ──────────────────────────────────────────────────────

interface GitHubEventContext {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  body: string;
  author: string;
}

// ── CI-completion → pr_review re-dispatch decision logic (#721) ──────────────
// Pure, exported so the gating is unit-testable without the network. The
// orchestration (_handleCiCompletion) wires these to GitHub REST + dispatch.

/** Head SHA carried by a `workflow_run` or `check_suite` completed payload. */
export function ciCompletionHeadSha(payload: Record<string, unknown>): string | undefined {
  const suite = (payload.workflow_run ?? payload.check_suite) as Record<string, unknown> | undefined;
  const sha = suite?.head_sha;
  return typeof sha === "string" && sha.length > 0 ? sha : undefined;
}

/**
 * A PR is eligible for a CI-completion re-review only when it's open, not a
 * draft, and its head is STILL this SHA — a newer push means a fresh review is
 * already in flight via `synchronize`, so re-reviewing the stale SHA is noise.
 */
export function prEligibleForCiReview(pr: Record<string, unknown>, headSha: string): boolean {
  const head = (pr.head as Record<string, unknown> | undefined)?.sha;
  return (
    typeof pr.number === "number" &&
    pr.state === "open" &&
    pr.draft !== true &&
    head === headSha
  );
}

/**
 * True when every check-run for the SHA is terminal (status "completed"), so
 * guardTerminalCi will permit a formal verdict. No checks → terminal (nothing
 * to wait for).
 */
export function allChecksTerminal(checkRuns: Array<Record<string, unknown>> | undefined): boolean {
  if (!Array.isArray(checkRuns) || checkRuns.length === 0) return true;
  return checkRuns.every((r) => r.status === "completed");
}

/** True iff the reviewer bot has already left a review on the PR (the provisional→formal case). */
export function quinnHasReviewed(
  reviews: Array<Record<string, unknown>> | undefined,
  bases: string[] = reviewerLoginBases(),
): boolean {
  if (!Array.isArray(reviews)) return false;
  return reviews.some((r) => {
    const login = (r.user as Record<string, unknown> | undefined)?.login;
    return typeof login === "string" && bases.some((b) => login.toLowerCase().startsWith(b));
  });
}

/**
 * Terminal-GREEN gate for the deterministic approve-on-green path (#748).
 *
 * A formal APPROVE enables auto-merge, so it must only fire when CI is not
 * merely terminal but actually PASSING — every check completed with a benign
 * conclusion (`success` / `neutral` / `skipped`), none failed/cancelled/
 * timed_out/stale, and nothing still in flight.
 *
 * FAIL CLOSED: an empty / unknown check set is NOT green. `guardTerminalCi`
 * treats no-checks as terminal (nothing to wait for), but "no checks" gives us
 * no positive green signal to auto-approve on, so the deterministic path
 * declines and the LLM re-dispatch handles it. A 403 / network failure on the
 * fetch surfaces as `undefined` here → not green.
 */
const GREEN_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
export function allChecksGreen(checkRuns: Array<Record<string, unknown>> | undefined): boolean {
  if (!Array.isArray(checkRuns) || checkRuns.length === 0) return false;
  return checkRuns.every((r) => {
    if (r.status !== "completed") return false;
    return typeof r.conclusion === "string" && GREEN_CONCLUSIONS.has(r.conclusion);
  });
}

/**
 * The state of @protoquinn[bot]'s LATEST review (by submission order), or
 * `undefined` when she has not reviewed. Drives the deterministic approve gate
 * (#748): only a latest `COMMENTED` review — Quinn reviewed, found no blockers,
 * and was held by guardTerminalCi while CI ran — is eligible for auto-approve.
 * A latest `CHANGES_REQUESTED` means blockers exist (never auto-approve); a
 * latest `APPROVED` means we are already done.
 *
 * GitHub returns reviews oldest-first, so the last protoquinn review wins.
 */
export function quinnLatestReviewState(
  reviews: Array<Record<string, unknown>> | undefined,
  bases: string[] = reviewerLoginBases(),
): string | undefined {
  if (!Array.isArray(reviews)) return undefined;
  let state: string | undefined;
  for (const r of reviews) {
    const login = (r.user as Record<string, unknown> | undefined)?.login;
    if (typeof login === "string" && bases.some((b) => login.toLowerCase().startsWith(b))) {
      const s = r.state;
      if (typeof s === "string") state = s.toUpperCase();
    }
  }
  return state;
}

/**
 * Detect a budget-exhausted PR review: the agent's ReAct loop hit its turn
 * ceiling ("Recursion limit of N reached…") or the run timed out before it
 * produced a formal verdict. ~1.6% of pr_review runs end this way (see
 * docs/explanation/code-review-agent-design.md) and historically left the PR
 * silently unreviewed. We escalate these to a human rather than fail to
 * nothing — and deliberately do NOT synthesize a COMMENT review, because a
 * COMMENTED state would let the approve-on-green path (#748) auto-approve a PR
 * that was never actually reviewed.
 */
export function isReviewBudgetExhausted(error: string | undefined): boolean {
  const m = (error ?? "").toLowerCase();
  if (!m) return false;
  return (
    m.includes("recursion limit") ||
    m.includes("timed out") ||
    m.includes("operation was aborted") ||
    m.includes("without hitting a stop condition")
  );
}

/**
 * Normalize a GitHub `release` webhook payload into a ReleasePublishedPayload,
 * or null when it isn't a published release worth surfacing (wrong action,
 * missing owner/repo/tag). Exported for unit testing; called from
 * `_handleEvent` for `event === "release"`.
 */
export function parseReleasePublished(
  payload: Record<string, unknown>,
): ReleasePublishedPayload | null {
  if (payload.action !== "published") return null;
  const release = payload.release as Record<string, unknown> | undefined;
  const repo = payload.repository as Record<string, unknown> | undefined;
  if (!release || !repo) return null;

  const owner = ((repo.owner as Record<string, unknown> | undefined)?.login as string) ?? "";
  const repoName = (repo.name as string) ?? "";
  const version = (release.tag_name as string) ?? "";
  if (!owner || !repoName || !version) return null;

  return {
    owner,
    repo: repoName,
    version,
    name: (release.name as string | null) ?? version,
    body: (release.body as string | null) ?? "",
    url: (release.html_url as string) ?? "",
    author: ((release.author as Record<string, unknown> | undefined)?.login as string) ?? "",
    prerelease: Boolean(release.prerelease),
    publishedAt: (release.published_at as string | null) ?? new Date().toISOString(),
  };
}

function extractContext(event: string, payload: Record<string, unknown>): GitHubEventContext | null {
  const repo = payload.repository as Record<string, unknown> | undefined;
  const owner = (repo?.owner as Record<string, unknown> | undefined)?.login as string | undefined;
  const repoName = repo?.name as string | undefined;

  if (!owner || !repoName) return null;

  if (event === "issue_comment") {
    const issue = payload.issue as Record<string, unknown>;
    const comment = payload.comment as Record<string, unknown>;
    return {
      owner, repo: repoName,
      number: issue.number as number,
      title: issue.title as string,
      url: comment.html_url as string,
      body: comment.body as string ?? "",
      author: (comment.user as Record<string, unknown>)?.login as string ?? "",
    };
  }

  if (event === "pull_request_review_comment") {
    const pr = payload.pull_request as Record<string, unknown>;
    const comment = payload.comment as Record<string, unknown>;
    return {
      owner, repo: repoName,
      number: pr.number as number,
      title: pr.title as string,
      url: comment.html_url as string,
      body: comment.body as string ?? "",
      author: (comment.user as Record<string, unknown>)?.login as string ?? "",
    };
  }

  if (event === "issues" && (payload.action === "opened" || payload.action === "reopened")) {
    const issue = payload.issue as Record<string, unknown>;
    return {
      owner, repo: repoName,
      number: issue.number as number,
      title: issue.title as string,
      url: issue.html_url as string,
      body: issue.body as string ?? "",
      author: (issue.user as Record<string, unknown>)?.login as string ?? "",
    };
  }

  if (event === "pull_request" && (
    payload.action === "opened" ||
    payload.action === "synchronize" ||
    payload.action === "review_requested"
  )) {
    const pr = payload.pull_request as Record<string, unknown>;
    return {
      owner, repo: repoName,
      number: pr.number as number,
      title: pr.title as string,
      url: pr.html_url as string,
      body: pr.body as string ?? "",
      author: (pr.user as Record<string, unknown>)?.login as string ?? "",
    };
  }

  return null;
}

// ── HMAC-SHA256 signature validation ─────────────────────────────────────────

async function validateSignature(secret: string, body: string, sigHeader: string | null): Promise<boolean> {
  if (!sigHeader?.startsWith("sha256=")) return false;
  const expected = sigHeader.slice(7);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");

  if (computed.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export class GitHubPlugin implements Plugin {
  readonly name = "github";
  readonly description = "GitHub webhook receiver — @mentions → bus → agent replies as comments";
  readonly capabilities = ["github-inbound", "github-outbound"];
  readonly publishes = [
    "message.inbound.github.{owner}.{repo}.{event}.{number}",
    "flow.item.created",
    "flow.item.updated",
    "flow.item.completed",
  ];
  readonly subscribes = [
    "message.outbound.github.#",
  ];

  private server: ReturnType<typeof Bun.serve> | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  private reconcileInFlight = false;
  /** How often the level-triggered approve-on-green sweep runs (#879). */
  private static readonly RECONCILE_INTERVAL_MS = 3 * 60_000;
  private workspaceDir: string;
  private projectRegistry: ProjectRegistry;
  private config!: GitHubConfig;

  constructor(workspaceDir: string, projectRegistry: ProjectRegistry) {
    this.workspaceDir = workspaceDir;
    this.projectRegistry = projectRegistry;
  }

  /**
   * Live per-repo project metadata (slug + projectPath) for the triage path.
   * Read from the registry on each call rather than a cached snapshot so a
   * project registered after startup is resolvable immediately.
   */
  private _projectMetaFor(repoSlug: string): { slug: string; projectPath: string | undefined } | undefined {
    const p = this.projectRegistry.getByGithub(repoSlug);
    return p ? { slug: p.slug, projectPath: p.path } : undefined;
  }

  install(bus: EventBus): void {
    const getToken = makeGitHubAuth();
    if (!getToken) {
      log.warn("No auth configured (GITHUB_APP_ID or GITHUB_TOKEN required) — plugin disabled");
      return;
    }

    const usingApp = !!(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
    log.info(`Auth: ${usingApp ? "GitHub App (quinn[bot])" : "PAT (GITHUB_TOKEN)"}`);

    this.config = loadConfig(this.workspaceDir);
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
    const port = parseInt(process.env.GITHUB_WEBHOOK_PORT ?? "8082", 10);

    if (!webhookSecret) {
      if (isProductionLike()) {
        // Fail loud rather than silently accepting forged GitHub webhooks (→ bus
        // → triage/skill routing) in a production-like env. Mirrors LinearPlugin. (#791)
        throw new Error(
          "[github] GITHUB_WEBHOOK_SECRET is required when NODE_ENV=production or " +
            "WORKSTACEAN_PUBLIC_BASE_URL is set. Refusing to start an unauthenticated " +
            "webhook receiver in production.",
        );
      }
      log.warn("GITHUB_WEBHOOK_SECRET not set — signature verification disabled (dev only)");
    }

    // ── Hot-reload github.yaml ────────────────────────────────────────────────
    // Project list lives in the project registry and is refreshed by the
    // registry's own interval — no file watcher needed for it here.
    const configPath = join(this.workspaceDir, "github.yaml");

    let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    const reloadConfig = () => {
      if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
      reloadDebounceTimer = setTimeout(() => {
        this.config = loadConfig(this.workspaceDir);
        const repoCount = this.projectRegistry.getGithubCoords().length;
        log.info(`Config reloaded — ${repoCount} monitored repo(s)`);
      }, 300);
    };

    // watchFile works even if the file doesn't exist yet — it will fire on creation.
    watchFile(configPath, { interval: 5_000 }, reloadConfig);

    // ── Outbound: post comment back to GitHub ────────────────────────────────
    bus.subscribe("message.outbound.github.#", "github-outbound", async (msg: BusMessage) => {
      const correlationId = msg.correlationId;
      if (!correlationId) return;

      const pending = pendingComments.get(correlationId);
      if (!pending) return;
      pendingComments.delete(correlationId);

      await this._handleOutboundReply(pending, correlationId, msg.payload as Record<string, unknown>, bus, getToken);
    });

    // ── Inbound: webhook HTTP server ─────────────────────────────────────────
    this.server = Bun.serve({
      port,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname !== "/webhook/github") return new Response("Not found", { status: 404 });
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

        const body = await req.text();

        if (webhookSecret) {
          const sig = req.headers.get("X-Hub-Signature-256");
          if (!await validateSignature(webhookSecret, body, sig)) {
            log.warn("Invalid webhook signature — request rejected");
            return new Response("Unauthorized", { status: 401 });
          }
        }

        const event = req.headers.get("X-GitHub-Event") ?? "";
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(body);
        } catch {
          return new Response("Bad request", { status: 400 });
        }

        this._handleEvent(event, payload, this.config, bus, getToken);
        return new Response("OK", { status: 200 });
      },
    });

    log.info(`Webhook receiver on :${port}/webhook/github`);

    // ── Level-triggered approve-on-green reconciliation sweep (#879) ──────────
    // Backstops the edge-triggered CI-completion webhook: a missed/raced
    // workflow_run/check_suite delivery otherwise strands a green PR forever.
    // The sweep re-runs the same deterministic approve decision over every open
    // PR. Single-flight so a slow sweep never overlaps itself.
    this.reconcileTimer = setInterval(() => {
      if (this.reconcileInFlight) return;
      this.reconcileInFlight = true;
      void this._reconcileApproveOnGreen(getToken)
        .catch((err) => log.error("Approve-on-green reconciliation sweep failed", { err }))
        .finally(() => { this.reconcileInFlight = false; });
    }, GitHubPlugin.RECONCILE_INTERVAL_MS);
  }

  uninstall(): void {
    this.server?.stop();
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    unwatchFile(join(this.workspaceDir, "github.yaml"));
  }

  private _handleEvent(
    event: string,
    payload: Record<string, unknown>,
    config: GitHubConfig,
    bus: EventBus,
    getToken: (owner: string, repo: string) => Promise<string>,
  ): void {
    // ── Org webhook: repository.created → onboard ─────────────────────────
    if (event === "repository" && payload.action === "created") {
      const repo = payload.repository as Record<string, unknown> | undefined;
      if (repo) {
        const repoName = repo.name as string;
        const fullName = repo.full_name as string;
        const owner = (repo.owner as Record<string, unknown> | undefined)?.login as string;
        const url = repo.html_url as string;
        const description = (repo.description as string | null) ?? "";
        const isPrivate = repo.private as boolean;

        const correlationId = crypto.randomUUID();
        const topic = "message.inbound.onboard";

        bus.publish(topic, {
          id: `repository-created-${fullName.replace("/", "-")}-${correlationId.slice(0, 8)}`,
          correlationId,
          topic,
          timestamp: Date.now(),
          payload: {
            event: "repository.created",
            owner,
            repo: repoName,
            fullName,
            url,
            description,
            isPrivate,
          },
          source: { interface: "github" as const },
        });

        log.info(`repository.created: ${fullName} → ${topic}`);
      }
      return;
    }

    // ── Release published → release.published (fleet lifecycle primitive) ─────
    // GitHub fires `release` on publish regardless of how the release was cut
    // (auto-release.yml `gh release create`, release-tools, or by hand). We
    // surface one canonical bus topic; content surfacing, changelog
    // aggregation, deploy verification, and announce subscribe without knowing
    // the mechanism. Requires the GitHub App to subscribe to `release` events.
    if (event === "release") {
      const rel = parseReleasePublished(payload);
      if (rel) {
        const correlationId = crypto.randomUUID();
        bus.publish("release.published", {
          id: `release-${rel.owner}-${rel.repo}-${rel.version}-${correlationId.slice(0, 8)}`,
          correlationId,
          topic: "release.published",
          timestamp: Date.now(),
          payload: rel,
          source: { interface: "github" as const },
        });
        log.info(`release.published: ${rel.owner}/${rel.repo} ${rel.version} → release.published`);
      }
      return;
    }

    // ── CI completion → re-dispatch pr_review (upgrade provisional → formal) ──
    // Quinn's terminal-CI guard (guardTerminalCi, #3886) holds the formal
    // verdict to a non-blocking COMMENT while CI is in flight, deferring the
    // APPROVE/REQUEST_CHANGES to "a later pass once every check is terminal."
    // Nothing re-invoked Quinn on CI completion, so clean PRs stalled at the
    // provisional COMMENT forever (#721). We re-dispatch here. Both
    // workflow_run and check_suite are accepted: GitHub Actions emits both, and
    // taking either guards against the check-run lag race (the just-finished
    // run sometimes still reads in_progress when its workflow_run lands).
    // Requires the GitHub App to subscribe to `workflow_run` + `check_suite`.
    if ((event === "workflow_run" || event === "check_suite") && payload.action === "completed") {
      void this._handleCiCompletion(event, payload, bus, getToken).catch((err) => {
        log.error("CI-completion re-review failed", { err });
      });
      return;
    }


    // ── PR lifecycle → flow.item.* (independent of @mention) ─────────────────
    if (event === "pull_request") {
      const action = payload.action as string;
      const pr = payload.pull_request as Record<string, unknown>;
      const repo = payload.repository as Record<string, unknown> | undefined;
      const owner = (repo?.owner as Record<string, unknown> | undefined)?.login as string ?? "";
      const repoName = repo?.name as string ?? "";
      const prNumber = pr?.number as number;
      const prId = `github-pr-${owner}-${repoName}-${prNumber}`;
      const isDraft = pr?.draft as boolean;

      if (action === "opened" && !isDraft) {
        bus.publish("flow.item.created", {
          id: crypto.randomUUID(),
          correlationId: prId,
          topic: "flow.item.created",
          timestamp: Date.now(),
          payload: {
            id: prId,
            type: "feature",
            status: "active",
            stage: "open",
            createdAt: Date.now(),
            meta: { source: "github", owner, repo: repoName, number: prNumber, title: pr?.title, url: pr?.html_url },
          },
        });
      } else if (action === "review_requested") {
        bus.publish("flow.item.updated", {
          id: crypto.randomUUID(),
          correlationId: prId,
          topic: "flow.item.updated",
          timestamp: Date.now(),
          payload: { id: prId, status: "active", stage: "review" },
        });
      } else if (action === "closed") {
        const merged = pr?.merged as boolean;
        if (merged) {
          bus.publish("flow.item.completed", {
            id: crypto.randomUUID(),
            correlationId: prId,
            topic: "flow.item.completed",
            timestamp: Date.now(),
            payload: { id: prId, status: "complete", stage: "done", completedAt: Date.now() },
          });
          // Index the merged PR (diff + symbols + review decision) into Qdrant so
          // future Quinn reviews have context from past decisions. Best-effort,
          // off the hot path — a Qdrant/network failure must never block the webhook.
          const mergePayload = parsePRMergePayload(event, payload);
          if (mergePayload) {
            void handlePRMerge(mergePayload, getToken).catch((err) =>
              log.warn(`PR-merge indexing failed for ${owner}/${repoName}#${prNumber}`, { err }),
            );
          }
        }
      }
    }

    // ── Review-learning side-effects (dismissal-tracker → Qdrant) ────────────
    // Developer replies to Quinn's inline comments, and dismissals of Quinn's
    // reviews, feed the review-learning pipeline so future reviews adapt to
    // pushback. Independent of the @mention / auto-review paths and best-effort.
    if (event === "pull_request_review_comment" && payload.action === "created") {
      void this._trackCommentResponse(payload, getToken).catch((err) =>
        log.warn("comment-response tracking failed", { err }),
      );
    }
    if (event === "pull_request_review" && payload.action === "dismissed") {
      void this._trackReviewDismissal(payload).catch((err) =>
        log.warn("review-dismissal tracking failed", { err }),
      );
    }

    const ctx = extractContext(event, payload);
    if (!ctx) return;

    // ── Self-cascade guard ─────────────────────────────────────────────────────
    // Drop issue + issue_comment + pull_request_review_comment events authored
    // by our own agent bots before they reach auto-triage or the @mention path.
    // Without this, Quinn files an issue → GitHub webhook → bug_triage →
    // Quinn files another issue → infinite cascade (protoWorkstacean#556 ate
    // itself with 23 duplicate triage issues in 60s). pull_request events
    // are intentionally NOT filtered here — agents open legitimate
    // bot-authored PRs that should still be reviewed; GitHub's self-approval
    // check already prevents same-account approvals.
    if (
      (event === "issues" || event === "issue_comment" || event === "pull_request_review_comment") &&
      isAgentBotActor(ctx.author)
    ) {
      log.info(
        `Dropping ${event}.${payload.action} on ${ctx.owner}/${ctx.repo}#${ctx.number} — ` +
        `authored by agent bot ${ctx.author} (self-cascade guard, see #556)`,
      );
      return;
    }

    // Issues on managed project repos are handled by workstacean's own triage
    // path. Workstacean does not blanket auto-triage every issue — admins who
    // want workstacean to act on a specific issue use the @mention path below.

    // ── Auto-review path: pull_request opened/synchronize ─────────────────────
    // Every opened/synchronized PR triggers Quinn's pr_review skill — no
    // @mention required. PRs are trusted by virtue of being in our repo;
    // Quinn's pr_inspector + system prompt do the gating on what to actually
    // verdict. Dedup'd via recentDispatches so a fast-updating branch doesn't
    // flood the bus.
    if (event === "pull_request" && (payload.action === "opened" || payload.action === "synchronize")) {
      this._handleAutoReview(event, payload, ctx, bus, getToken, { skipDedup: false });
      return;
    }

    // ── Re-review path: pull_request review_requested for @protoquinn[bot] ────
    // Native GitHub "Re-request review" button → Quinn re-reviews. Bypasses
    // dedup because the human is explicitly asking. Other review_requested
    // events (for human reviewers) are ignored.
    if (event === "pull_request" && payload.action === "review_requested") {
      const reviewer = payload.requested_reviewer as Record<string, unknown> | undefined;
      const login = (reviewer?.login as string | undefined)?.toLowerCase();
      const isReviewerBot = !!login && getFleetConfig().reviewerBotLogins.some((l) => l.toLowerCase() === login);
      if (isReviewerBot) {
        this._handleAutoReview(event, payload, ctx, bus, getToken, { skipDedup: true });
      }
      return;
    }

    // ── @mention path (existing, unchanged) ──────────────────────────────────
    if (!ctx.body.toLowerCase().includes(config.mentionHandle.toLowerCase())) return;

    if (config.admins?.length && !config.admins.some(a => a.toLowerCase() === ctx.author.toLowerCase())) {
      log.info(`${event} from @${ctx.author} ignored — not in admins list`);
      return;
    }

    // Acknowledge receipt — eyes reaction, fire-and-forget
    (async () => {
      const token = await getToken(ctx.owner, ctx.repo);
      let url: string;
      if (event === "issue_comment" || event === "pull_request_review_comment") {
        const id = (payload.comment as Record<string, unknown>)?.id;
        const base = event === "issue_comment" ? "issues/comments" : "pulls/comments";
        url = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/${base}/${id}/reactions`;
      } else {
        url = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}/reactions`;
      }
      const res = await withCircuitBreaker("github-api", () =>
        fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "protoWorkstacean/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({ content: "eyes" }),
        }),
      );
      if (!res.ok) log.error(`reaction failed ${res.status}: ${await res.text()}`);
    })().catch(err => log.error("reaction error", { err }));

    // A top-level comment on a PR arrives as an `issue_comment` event — GitHub
    // models PR conversation comments as issue comments. The default
    // issue_comment route is bug_triage, but when the mention is on a PR the
    // operator wants a review, so route to the pull_request skill (pr_review)
    // instead. Review-thread replies already arrive as pull_request_review_comment.
    const isPrComment =
      event === "issue_comment" &&
      !!(payload.issue as Record<string, unknown> | undefined)?.pull_request;
    const skillHint = isPrComment
      ? (config.skillHints.pull_request ?? config.skillHints[event])
      : config.skillHints[event];
    const correlationId = crypto.randomUUID();

    pendingComments.set(correlationId, { owner: ctx.owner, repo: ctx.repo, number: ctx.number });

    const content = [
      `${config.mentionHandle} — ${event} on ${ctx.owner}/${ctx.repo}#${ctx.number}`,
      `Title: ${ctx.title}`,
      `Author: @${ctx.author}`,
      `URL: ${ctx.url}`,
      ``,
      ctx.body,
    ].join("\n");

    const topic = `message.inbound.github.${ctx.owner}.${ctx.repo}.${event}.${ctx.number}`;
    const replyTopic = `message.outbound.github.${ctx.owner}.${ctx.repo}.${ctx.number}`;

    bus.publish(topic, {
      id: `${event}-${ctx.owner}-${ctx.repo}-${ctx.number}-${correlationId.slice(0, 8)}`,
      correlationId,
      topic,
      timestamp: Date.now(),
      payload: {
        sender: ctx.author,
        channel: `${ctx.owner}/${ctx.repo}#${ctx.number}`,
        content,
        skillHint,
        github: { event, owner: ctx.owner, repo: ctx.repo, number: ctx.number, title: ctx.title, url: ctx.url },
      },
      source: { interface: "github" as const },
      reply: { topic: replyTopic },
    });

    log.info(`${event} on ${ctx.owner}/${ctx.repo}#${ctx.number} → ${skillHint ?? "default"}`);
  }

  /** Tracks recently-dispatched (owner/repo#number) to suppress duplicate webhook deliveries. */
  private recentDispatches = new Map<string, number>();
  private static readonly DEDUP_WINDOW_MS = 60_000;

  /**
   * Repos Quinn has auto-reviewed this process. The approve-on-green
   * reconciliation sweep unions this with the project registry so a repo that
   * receives webhook auto-reviews but isn't registered still gets the
   * deterministic approve-on-green — otherwise its held COMMENT is stranded
   * (never promoted, never merged), the gap that silently stalled a freshly
   * stood-up protoAgent-family repo (portfolio-plugin).
   */
  private readonly reviewedRepoCoords = new Set<string>();

  private _handleAutoReview(
    event: string,
    payload: Record<string, unknown>,
    ctx: GitHubEventContext,
    bus: EventBus,
    getToken: (owner: string, repo: string) => Promise<string>,
    opts: { skipDedup: boolean } = { skipDedup: false },
  ): void {
    const action = payload.action as string;
    const dedupKey = `pr-review:${ctx.owner}/${ctx.repo}#${ctx.number}`;
    if (!opts.skipDedup) {
      const lastDispatched = this.recentDispatches.get(dedupKey);
      if (lastDispatched && Date.now() - lastDispatched < GitHubPlugin.DEDUP_WINDOW_MS) {
        log.info(`Auto-review: skipping duplicate ${dedupKey} (dispatched ${Date.now() - lastDispatched}ms ago)`);
        return;
      }
    }
    this.recentDispatches.set(dedupKey, Date.now());

    const pr = payload.pull_request as Record<string, unknown>;
    const isDraft = pr?.draft as boolean;
    if (isDraft) {
      log.info(`Auto-review: skipping draft PR ${ctx.owner}/${ctx.repo}#${ctx.number}`);
      return;
    }

    // Head SHA — threaded through to the dispatcher so cooldown keys can
    // include it. Without this, two pushes to the same PR within the
    // cooldown window dropped the second silently; with headSha in the
    // key, a new commit always reviews (only repeated webhooks for the
    // same SHA dedup). See flow-pr-review.md.
    const head = pr?.head as Record<string, unknown> | undefined;
    const headSha = typeof head?.["sha"] === "string" ? (head["sha"] as string) : undefined;

    const correlationId = crypto.randomUUID();
    pendingComments.set(correlationId, { owner: ctx.owner, repo: ctx.repo, number: ctx.number });

    // Stamp the webhook-arrival time so skill-dispatcher can compute
    // webhook→done latency at completion. The /system trace view (D1)
    // already has per-message timestamps via BusHistoryRecorder; this
    // gives us a clean one-line summary in workstacean's stdout too.
    const webhookArrivedAt = Date.now();

    const content = [
      `Auto-review — pull_request.${action} on ${ctx.owner}/${ctx.repo}#${ctx.number}`,
      `Title: ${ctx.title}`,
      `Author: @${ctx.author}`,
      `URL: ${ctx.url}`,
      ``,
      `Use pr_inspector with repo="${ctx.owner}/${ctx.repo}" and pr_number=${ctx.number} to pull CI status, the diff, and any unresolved review threads. Issue your verdict (PASS / WARN / FAIL) via review_approve / review_comment / review_request_changes.`,
      ``,
      ctx.body,
    ].join("\n");

    const topic = `message.inbound.github.${ctx.owner}.${ctx.repo}.${event}.${ctx.number}`;
    const replyTopic = `message.outbound.github.${ctx.owner}.${ctx.repo}.${ctx.number}`;

    bus.publish(topic, {
      id: `${event}-${action}-${ctx.owner}-${ctx.repo}-${ctx.number}-${correlationId.slice(0, 8)}`,
      correlationId,
      topic,
      timestamp: webhookArrivedAt,
      payload: {
        sender: ctx.author,
        channel: `${ctx.owner}/${ctx.repo}#${ctx.number}`,
        content,
        skillHint: "pr_review",
        github: {
          event,
          action,
          owner: ctx.owner,
          repo: ctx.repo,
          number: ctx.number,
          title: ctx.title,
          url: ctx.url,
          headSha,
        },
        meta: { webhookArrivedAt },
      },
      source: { interface: "github" as const },
      reply: { topic: replyTopic },
    });

    log.info(`Auto-review: ${ctx.owner}/${ctx.repo}#${ctx.number} (${action}) → pr_review`);

    // Record the repo so the approve-on-green sweep covers it even when it's
    // not in the project registry. A webhook-reviewed repo that isn't
    // registered would otherwise get COMMENTs but never the deterministic
    // approve-on-green (the sweep is registry-driven). Warn once so the repo
    // gets tagged into the registry properly (which persists across restarts).
    const reviewedCoord = `${ctx.owner}/${ctx.repo}`;
    if (!this.reviewedRepoCoords.has(reviewedCoord)) {
      this.reviewedRepoCoords.add(reviewedCoord);
      const registered = this.projectRegistry
        .getGithubCoords()
        .some((c) => c.toLowerCase() === reviewedCoord.toLowerCase());
      if (!registered) {
        log.warn(
          `Auto-review on ${reviewedCoord}, which is NOT in the project registry. ` +
            `Covering it in the approve-on-green sweep for this process, but tag the ` +
            `repo with the 'protoagent-plugin' GitHub topic (or add it to ` +
            `sync-project-registry.sh) so coverage persists across restarts.`,
        );
      }
    }

    // Leading acknowledgment comment so the PR shows Quinn engagement
    // immediately, not minutes later when the formal verdict review
    // lands. GitHub Apps can't be added as requested reviewers
    // (collaborator-only), so an explicit timeline comment is the
    // closest equivalent UI signal. Same pattern Renovate / Dependabot
    // / CodeRabbit use.
    //
    // Gated on `opened` only — `synchronize` and `review_requested`
    // already happen against PRs that have a prior leading comment,
    // so re-posting would be noise. Best-effort: a failure here must
    // never block the actual dispatch above.
    if (action === "opened") {
      void this._postComment(
        getToken,
        { owner: ctx.owner, repo: ctx.repo, number: ctx.number },
        "👀 Quinn is reviewing — verdict (PASS / WARN / FAIL) + findings to follow.",
      ).catch((err) => {
        log.warn(
          `Auto-review: leading-comment post failed for ${ctx.owner}/${ctx.repo}#${ctx.number}`,
          { err },
        );
      });
    }
  }

  /**
   * Re-dispatch pr_review when CI completes, so Quinn's provisional COMMENT
   * (held by guardTerminalCi while checks were in flight) upgrades to a formal
   * APPROVE / REQUEST_CHANGES (#721). Fires for `workflow_run` and `check_suite`
   * completed events, both keyed by head SHA.
   *
   * Targeted, not a blanket re-review:
   *  - resolves the open PR(s) whose head is this SHA,
   *  - only re-reviews PRs Quinn has ALREADY reviewed (the provisional→formal
   *    case — never a surprise first-touch from a CI event),
   *  - gates on ALL checks being terminal, so it dispatches once at the true
   *    terminal moment rather than once per finishing workflow.
   * The dispatcher's `@sha7` cooldown (#437) is the backstop against any
   * residual burst from the two event types arriving together.
   */
  /**
   * Process a skill reply bound for a GitHub PR (the `message.outbound.github.#`
   * subscriber body — extracted so the budget-exhaustion path is unit-testable
   * by driving it directly). On a normal reply, post the agent's content as a
   * PR comment. On a budget-exhausted review (recursion limit / timeout, no
   * verdict), escalate to a human instead of failing silently — and never post
   * it as a review, since a COMMENTED state would let approve-on-green (#748)
   * auto-approve a PR that was never actually reviewed.
   */
  private async _handleOutboundReply(
    pending: PendingComment,
    correlationId: string,
    payload: Record<string, unknown>,
    bus: EventBus,
    getToken: (owner: string, repo: string) => Promise<string>,
  ): Promise<void> {
    const error = typeof payload.error === "string" ? payload.error : undefined;

    if (isReviewBudgetExhausted(error)) {
      const slug = `${pending.owner}/${pending.repo}#${pending.number}`;
      log.warn(`pr_review budget-exhausted for ${slug} — escalating to operator (no verdict produced): ${error}`);
      bus.publish("operator.message.request", {
        id: crypto.randomUUID(),
        correlationId,
        topic: "operator.message.request",
        timestamp: Date.now(),
        payload: {
          type: "operator_message_request",
          correlationId,
          message:
            `Quinn could not finish reviewing ${slug} — the review ran out of budget ` +
            `(${error}) and produced no verdict. The PR is unreviewed; it needs a human ` +
            `review or a re-run. https://github.com/${pending.owner}/${pending.repo}/pull/${pending.number}`,
          urgency: "normal",
          topic: `pr-review-incomplete/${slug}`,
          from: "github",
        },
      });
      return;
    }

    const content = String(payload.content ?? "").trim();
    if (!content) return;
    if (/^Skill ".+" completed by \w+$/i.test(content)) return;

    await this._postComment(getToken, pending, content);
  }

  private async _handleCiCompletion(
    event: string,
    payload: Record<string, unknown>,
    bus: EventBus,
    getToken: (owner: string, repo: string) => Promise<string>,
  ): Promise<void> {
    const repository = payload.repository as Record<string, unknown> | undefined;
    const owner = ((repository?.owner as Record<string, unknown> | undefined)?.login) as string | undefined;
    const repo = repository?.name as string | undefined;
    const headSha = ciCompletionHeadSha(payload);
    if (!owner || !repo || !headSha) return;

    const pulls = (await this._ghGet(getToken, owner, repo, `/repos/${owner}/${repo}/commits/${headSha}/pulls`)) as
      | Array<Record<string, unknown>>
      | null;
    if (!Array.isArray(pulls) || pulls.length === 0) return;

    for (const pr of pulls) {
      const decision = await this._evaluateApproveOnGreen(event, owner, repo, pr, headSha, getToken);
      if (decision !== "needs-review") continue;

      // Eligible + terminal but not auto-approvable — re-dispatch Quinn's
      // pr_review LLM pass to upgrade the provisional COMMENT to a formal verdict.
      const number = pr.number as number;
      const ctx: GitHubEventContext = {
        owner,
        repo,
        number,
        title: (pr.title as string | undefined) ?? "",
        url: (pr.html_url as string | undefined) ?? "",
        body: (pr.body as string | undefined) ?? "",
        author: ((pr.user as Record<string, unknown> | undefined)?.login as string | undefined) ?? "",
      };
      // Synthesize the shape _handleAutoReview reads (pull_request.draft +
      // pull_request.head.sha). skipDedup: the all-terminal gate already ensures
      // a single meaningful dispatch; the dispatcher's @sha7 cooldown collapses
      // any workflow_run+check_suite co-arrival.
      const synthPayload: Record<string, unknown> = { action: "ci_completed", pull_request: pr };
      log.info(`CI-completion (${event}): re-dispatching pr_review for ${owner}/${repo}#${number} @${headSha.slice(0, 7)}`);
      // event="pull_request" so the published topic is byte-identical to a
      // normal auto-review (the routed path is proven); the "ci_completed"
      // action just suppresses the opened-only leading comment.
      this._handleAutoReview("pull_request", synthPayload, ctx, bus, getToken, { skipDedup: true });
    }
  }

  /**
   * Deterministic approve-on-terminal-green decision for a single PR (#748,
   * #848). Shared by the edge-triggered CI-completion webhook and the
   * level-triggered reconciliation sweep (#879), so both apply identical approve
   * criteria.
   *
   * Quinn reliably re-COMMENTs instead of choosing review_approve, so the
   * merge-on-green gate never opens (approvedCount stays 0). When CI is
   * terminal-GREEN and Quinn's latest review is a held COMMENT (no blockers),
   * post the formal APPROVE programmatically rather than re-prompting the LLM.
   *
   * A prior CHANGES_REQUESTED + now-green is also auto-approved: the blocker
   * Quinn raised (typically failing CI) is resolved, so the re-review maps to
   * PASS, not WARN. Without this, Quinn returns COMMENTED, which does NOT
   * dismiss the prior CHANGES_REQUESTED → PR stuck in merge-limbo (#848).
   *
   * Returns:
   *   "approved"     — posted the formal APPROVE (or a racing invocation did).
   *   "needs-review" — eligible + terminal but not auto-approvable; the caller
   *                    may re-dispatch the LLM pr_review (webhook path only —
   *                    the reconciliation sweep ignores this and skips).
   *   "skip"         — not eligible (stale/draft/closed), Quinn hasn't reviewed,
   *                    or CI is not all-terminal yet. Nothing to do.
   *
   * `source` labels log lines with what triggered the evaluation
   * ("workflow_run" / "check_suite" / "reconcile").
   */
  private async _evaluateApproveOnGreen(
    source: string,
    owner: string,
    repo: string,
    pr: Record<string, unknown>,
    headSha: string,
    getToken: (owner: string, repo: string) => Promise<string>,
  ): Promise<"approved" | "needs-review" | "skip"> {
    const number = pr.number as number;
    if (!prEligibleForCiReview(pr, headSha)) return "skip";

    const reviews = (await this._ghGet(getToken, owner, repo, `/repos/${owner}/${repo}/pulls/${number}/reviews`)) as
      | Array<Record<string, unknown>>
      | null;
    if (!quinnHasReviewed(reviews ?? undefined)) return "skip";
    if (!(await this._ciTerminal(getToken, owner, repo, headSha))) {
      log.info(`CI-completion (${source}): ${owner}/${repo}#${number} — checks not all terminal yet, deferring`);
      return "skip";
    }

    // Fail closed: an already-APPROVED PR, no prior Quinn review, or any
    // non-green / unverifiable CI state returns "needs-review" (caller decides
    // whether to re-dispatch the LLM).
    const latestState = quinnLatestReviewState(reviews ?? undefined);
    let autoApprove = false;
    let isResolvedBlocker = false;
    if ((latestState === "COMMENTED" || latestState === "CHANGES_REQUESTED") && (await this._ciGreen(getToken, owner, repo, headSha))) {
      if (latestState === "CHANGES_REQUESTED") {
        // A prior block only clears when the *requested change is in* — not
        // on CI-green alone. A code finding (auth bypass, data-loss, logic
        // bug) leaves an unresolved review thread that green CI doesn't
        // resolve; a CI-only block leaves none. Gate on unresolved threads
        // (#858). Fail safe: unknown thread state → don't auto-clear; defer
        // to the LLM re-review.
        const unresolved = await this._hasUnresolvedReviewThreads(getToken, owner, repo, number);
        if (unresolved === false) {
          autoApprove = true;
          isResolvedBlocker = true;
        } else {
          log.info(
            `CI-completion (${source}): ${owner}/${repo}#${number} prior CHANGES_REQUESTED + green but ` +
              `${unresolved === null ? "review-thread state unverifiable" : "unresolved review threads remain"} ` +
              `— not auto-clearing the block, deferring to re-review (#858)`,
          );
        }
      } else {
        // COMMENTED = Quinn's WARN / no-formal-blocker verdict. Green CI alone is NOT
        // enough: CodeRabbit and reviewers post code findings as unresolved REVIEW
        // THREADS, and a HIGH/MEDIUM note left as a thread must not auto-merge on green.
        // Gate the COMMENTED path on unresolved threads too — the same rule the
        // CHANGES_REQUESTED branch already applies (#858). Fail safe: unknown thread
        // state → don't auto-approve; defer to re-review.
        const unresolved = await this._hasUnresolvedReviewThreads(getToken, owner, repo, number);
        if (unresolved === false) {
          autoApprove = true;
        } else {
          log.info(
            `CI-completion (${source}): ${owner}/${repo}#${number} COMMENTED + green but ` +
              `${unresolved === null ? "review-thread state unverifiable" : "unresolved review threads remain"} ` +
              `— not auto-approving on green, deferring to re-review`,
          );
        }
      }
    }
    if (!autoApprove) return "needs-review";

    // Collapse co-arriving terminal webhooks. GitHub fires check_suite,
    // workflow_run, and check_run completions near-simultaneously; each runs
    // this concurrently and reads `reviews` before any has posted its APPROVE,
    // so every one sees latestState COMMENTED and submits a duplicate. The
    // reconciliation sweep (#879) can also race a late webhook for the same
    // (PR, SHA). Guard here: the get/set is synchronous (no await between), so
    // exactly one racing invocation claims the key; the rest skip.
    const approveKey = `approve-on-green:${owner}/${repo}#${number}@${headSha.slice(0, 7)}`;
    const lastApproved = this.recentDispatches.get(approveKey);
    if (lastApproved && Date.now() - lastApproved < GitHubPlugin.DEDUP_WINDOW_MS) {
      log.info(
        `CI-completion (${source}): skipping duplicate approve-on-green ${approveKey} ` +
          `(approved ${Date.now() - lastApproved}ms ago)`,
      );
      return "approved";
    }
    this.recentDispatches.set(approveKey, Date.now());
    try {
      const submitter = new GitHubReviewSubmitter(getToken);
      await submitter.submitReview(
        owner,
        repo,
        number,
        headSha,
        "APPROVE",
        isResolvedBlocker
          ? "CI terminal-green, prior blocker resolved — auto-approving on green (#848)."
          : "CI terminal-green, no blockers on prior review — auto-approving on green (#748).",
        [],
      );
      log.info(
        `CI-completion (${source}): auto-approved ${owner}/${repo}#${number} @${headSha.slice(0, 7)} ` +
          `(terminal-green, prior Quinn review ${latestState}${isResolvedBlocker ? ", blocker resolved" : ""})`,
      );

      // ── Visible promotion ack on the PR timeline (#887) ────────────────
      // The formal APPROVE flips GitHub's review state, but Quinn's earlier
      // COMMENTED body still reads "CI still queued…" — a later reader sees a
      // WARN-flavored comment under an APPROVED state with no explanation of
      // why/when it was promoted. Post a short timeline comment so the visible
      // history is self-explanatory regardless of which path (edge webhook or
      // reconciliation sweep) did the promoting. Best-effort: a failure here
      // must never block the approve flow.
      void this._postComment(
        getToken,
        { owner, repo, number },
        isResolvedBlocker
          ? `✅ CI went terminal-green and the prior change request is resolved — promoting the earlier review to **APPROVED** per the approve-on-green policy ([#848](https://github.com/protoLabsAI/protoWorkstacean/issues/848)).`
          : `✅ CI went terminal-green with no blockers on the prior review — promoting it to **APPROVED** per the approve-on-green policy ([#748](https://github.com/protoLabsAI/protoWorkstacean/issues/748)).`,
      );

      // ── Enable native auto-merge (squash) for one-off PRs ──────────────
      // After auto-approving, arm GitHub's native auto-merge so the PR
      // lands without a manual click. Only for one-off PRs targeting the
      // default branch — stacked PRs (base != main) are excluded, since
      // squash would break subsequent stack rebases. Best-effort: a
      // failure here must never block the approve flow.
      const baseRef = (pr.base as Record<string, unknown> | undefined)?.ref as string | undefined;
      if (baseRef === "main") {
        void this._enableAutoMerge(getToken, owner, repo, number, baseRef, "squash");
      } else if (baseRef) {
        log.info(
          `CI-completion (${source}): skipping auto-merge for ${owner}/${repo}#${number} ` +
            `(base=${baseRef} — not a one-off PR)`,
        );
      }
    } catch (err) {
      log.error(
        `CI-completion (${source}): auto-approve failed for ${owner}/${repo}#${number}`,
        { err },
      );
    }
    return "approved";
  }

  /**
   * Level-triggered reconciliation sweep for approve-on-green (#879).
   *
   * The edge-triggered `_handleCiCompletion` fires on a single
   * `workflow_run`/`check_suite` completion webhook. When that one delivery is
   * missed or races (e.g. it coincides with the container finishing the PR's own
   * pr_review), there is no retry — the PR is stranded green forever. This sweep
   * backstops the webhook with the standard controller edge+level pattern: it
   * walks every open PR across the monitored repos and re-runs the SAME approve
   * decision (`_evaluateApproveOnGreen`) with no change to the criteria.
   *
   * It deliberately acts ONLY on the approve path. A "needs-review" result
   * (eligible + terminal but not auto-approvable) is left alone — re-dispatching
   * the LLM pr_review on every sweep would spam reviews. The idempotency is
   * natural: once a PR is APPROVED, `quinnLatestReviewState` reads APPROVED and
   * the decision declines on the next sweep.
   */
  private async _reconcileApproveOnGreen(
    getToken: (owner: string, repo: string) => Promise<string>,
  ): Promise<void> {
    // Union the registry with repos Quinn has reviewed this process. A repo
    // that receives webhook auto-reviews but isn't registered would otherwise
    // be invisible here, so its held COMMENT would never be promoted to the
    // deterministic approve-on-green (the gap that stranded portfolio-plugin).
    const coords = new Set(this.projectRegistry.getGithubCoords());
    for (const c of this.reviewedRepoCoords) coords.add(c);
    let approved = 0;
    for (const coord of coords) {
      const slash = coord.indexOf("/");
      if (slash <= 0) continue;
      const owner = coord.slice(0, slash);
      const repo = coord.slice(slash + 1);

      const pulls = (await this._ghGet(
        getToken,
        owner,
        repo,
        `/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
      )) as Array<Record<string, unknown>> | null;
      if (!Array.isArray(pulls) || pulls.length === 0) continue;

      for (const pr of pulls) {
        const headSha = (pr.head as Record<string, unknown> | undefined)?.sha;
        if (typeof headSha !== "string" || headSha.length === 0) continue;
        try {
          const decision = await this._evaluateApproveOnGreen("reconcile", owner, repo, pr, headSha, getToken);
          if (decision === "approved") approved++;
        } catch (err) {
          log.error(
            `Reconcile approve-on-green failed for ${owner}/${repo}#${pr.number}`,
            { err },
          );
        }
      }
    }
    if (approved > 0) {
      log.info(`Approve-on-green reconciliation sweep: ${approved} stranded PR(s) approved`);
    }
  }

  /** Authenticated GitHub REST GET. Returns parsed JSON, or null on any failure (best-effort). */
  private async _ghGet(
    getToken: (owner: string, repo: string) => Promise<string>,
    owner: string,
    repo: string,
    path: string,
  ): Promise<unknown> {
    try {
      const token = await getToken(owner, repo);
      const res = await withCircuitBreaker("github-api", () =>
        fetch(`https://api.github.com${path}`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "protoWorkstacean/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }),
      );
      if (!res.ok) {
        log.warn(`GET ${path} → ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      log.error(`GET ${path} error`, { err });
      return null;
    }
  }

  /**
   * True when every check-run for the SHA is terminal, so guardTerminalCi will
   * permit a formal verdict.
   */
  private async _ciTerminal(
    getToken: (owner: string, repo: string) => Promise<string>,
    owner: string,
    repo: string,
    headSha: string,
  ): Promise<boolean> {
    const data = (await this._ghGet(getToken, owner, repo, `/repos/${owner}/${repo}/commits/${headSha}/check-runs`)) as
      | { check_runs?: Array<Record<string, unknown>> }
      | null;
    return allChecksTerminal(data?.check_runs);
  }

  /**
   * True only when every check-run for the SHA is terminal AND green (#748).
   * Fail closed: `_ghGet` returns null on a 403 / network failure, and
   * `allChecksGreen(undefined)` is false — an unverifiable or empty CI state
   * never reads as green, so the deterministic auto-approve declines.
   */
  private async _ciGreen(
    getToken: (owner: string, repo: string) => Promise<string>,
    owner: string,
    repo: string,
    headSha: string,
  ): Promise<boolean> {
    const data = (await this._ghGet(getToken, owner, repo, `/repos/${owner}/${repo}/commits/${headSha}/check-runs`)) as
      | { check_runs?: Array<Record<string, unknown>> }
      | null;
    return allChecksGreen(data?.check_runs);
  }

  /**
   * True if the PR has any unresolved review thread. Used to decide whether a
   * prior CHANGES_REQUESTED is actually resolved before auto-clearing it on
   * green (#858) — a code finding leaves an unresolved thread; a CI-only block
   * leaves none. Thread-resolution state is GraphQL-only (REST doesn't expose
   * it). Returns null when it can't be determined (auth/network/GraphQL error),
   * and the caller treats null as "don't auto-clear" (fail safe).
   */
  private async _hasUnresolvedReviewThreads(
    getToken: (owner: string, repo: string) => Promise<string>,
    owner: string,
    repo: string,
    number: number,
  ): Promise<boolean | null> {
    try {
      const token = await getToken(owner, repo);
      const query =
        "query($owner:String!,$repo:String!,$num:Int!){repository(owner:$owner,name:$repo){" +
        "pullRequest(number:$num){reviewThreads(first:100){nodes{isResolved}}}}}";
      const resp = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "protoWorkstacean/1.0",
        },
        body: JSON.stringify({ query, variables: { owner, repo, num: number } }),
      });
      if (!resp.ok) return null;
      const json = (await resp.json()) as {
        data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: Array<{ isResolved?: boolean }> } } } };
      };
      const nodes = json.data?.repository?.pullRequest?.reviewThreads?.nodes;
      if (!Array.isArray(nodes)) return null;
      return nodes.some((n) => n?.isResolved === false);
    } catch {
      return null;
    }
  }

  /**
   * A developer replied to an inline review comment. If the parent comment was
   * Quinn's, feed the reply into the review-learning pipeline (dismissal-tracker)
   * with Quinn's original comment as the matched context.
   */
  private async _trackCommentResponse(
    payload: Record<string, unknown>,
    getToken: (owner: string, repo: string) => Promise<string>,
  ): Promise<void> {
    const comment = payload.comment as Record<string, unknown> | undefined;
    const inReplyTo = comment?.in_reply_to_id as number | undefined;
    if (!inReplyTo) return; // only replies, not top-level comments

    const repository = payload.repository as Record<string, unknown> | undefined;
    const owner = (repository?.owner as Record<string, unknown> | undefined)?.login as string | undefined;
    const repo = repository?.name as string | undefined;
    if (!owner || !repo) return;

    // Fetch the parent comment — only track replies to *Quinn's* comments.
    const parent = (await this._ghGet(getToken, owner, repo, `/repos/${owner}/${repo}/pulls/comments/${inReplyTo}`)) as
      | { user?: { login?: string }; body?: string }
      | null;
    const parentAuthor = parent?.user?.login;
    if (!parentAuthor || !parentAuthor.toLowerCase().startsWith("protoquinn")) return;

    await handleCommentResponse(payload as unknown as ReviewCommentPayload, parent.body ?? "");
  }

  /** A Quinn review was dismissed — record the dismissal + reason for learning. */
  private async _trackReviewDismissal(payload: Record<string, unknown>): Promise<void> {
    const review = payload.review as Record<string, unknown> | undefined;
    const login = (review?.user as Record<string, unknown> | undefined)?.login as string | undefined;
    if (!login || !login.toLowerCase().startsWith("protoquinn")) return; // only Quinn's own reviews
    await handleReviewDismissal(payload as unknown as ReviewDismissalPayload, (review?.body as string | null) ?? "", "");
  }

  /**
   * Enable GitHub native auto-merge on a PR (PUT /repos/{o}/{r}/pulls/{n}/merge_upwards).
   *
   * Only for one-off PRs (base = default branch). Stacked PRs are excluded —
   * squash would break subsequent stack rebases, and arming auto-merge on a
   * moving stack is a capture-head-SHA footgun.
   *
   * Best-effort: failure here must never block the approve-on-green flow.
   */
  private async _enableAutoMerge(
    getToken: (owner: string, repo: string) => Promise<string>,
    owner: string,
    repo: string,
    prNumber: number,
    baseRef: string,
    mergeMethod: "squash" | "merge" = "squash",
  ): Promise<void> {
    const REST_HEADERS = (token: string) => ({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.github+json",
      "User-Agent": "protoWorkstacean/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    try {
      const token = await getToken(owner, repo);

      // Resolve the PR's GraphQL node id. Enabling auto-merge is a GraphQL-only
      // mutation — there is NO REST endpoint (the prior PUT to /merge_upwards
      // 404'd every time, so no approved+green PR ever landed).
      const prRes = await withCircuitBreaker("github-api", () =>
        fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
          headers: REST_HEADERS(token),
        }),
      );
      if (!prRes.ok) {
        log.warn(`enableAutoMerge: PR fetch ${prRes.status} for ${owner}/${repo}#${prNumber}`);
        return;
      }
      const prNodeId = ((await prRes.json()) as { node_id?: string }).node_id;
      if (!prNodeId) {
        log.warn(`enableAutoMerge: no node_id for ${owner}/${repo}#${prNumber}`);
        return;
      }

      // Arm GitHub native auto-merge (merges once branch protection is satisfied —
      // covers the brief window where the just-submitted approval hasn't been
      // counted yet). GraphQL enum is upper-case: SQUASH | MERGE | REBASE.
      const mutation =
        `mutation($id:ID!,$m:PullRequestMergeMethod!){` +
        `enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$m}){pullRequest{number}}}`;
      const res = await withCircuitBreaker("github-api", () =>
        fetch(`https://api.github.com/graphql`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "protoWorkstacean/1.0" },
          body: JSON.stringify({ query: mutation, variables: { id: prNodeId, m: mergeMethod.toUpperCase() } }),
        }),
      );
      const data = (await res.json().catch(() => ({}))) as { errors?: Array<{ message?: string }> };
      const errMsg = (data.errors ?? []).map((e) => e.message ?? "").join("; ");
      if (res.ok && !errMsg) {
        log.info(`Auto-merge enabled (${mergeMethod}) for ${owner}/${repo}#${prNumber} (base=${baseRef})`);
        return;
      }

      // GitHub refuses auto-merge when the PR is ALREADY mergeable with nothing
      // pending ("Pull request is in clean status"). By this path CI is
      // terminal-green and Quinn approved, so that's the common case — just merge
      // it directly via the real REST merge endpoint.
      if (/clean status|correct state|mergeable|not required/i.test(errMsg)) {
        const mergeRes = await withCircuitBreaker("github-api", () =>
          fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
            method: "PUT",
            headers: REST_HEADERS(token),
            body: JSON.stringify({ merge_method: mergeMethod }),
          }),
        );
        if (mergeRes.ok) {
          log.info(`Direct-merged (${mergeMethod}) ${owner}/${repo}#${prNumber} — already mergeable (base=${baseRef})`);
        } else {
          log.warn(
            `Direct merge ${mergeRes.status} for ${owner}/${repo}#${prNumber}: ${(await mergeRes.text().catch(() => "")).slice(0, 200)}`,
          );
        }
        return;
      }

      log.warn(`enableAutoMerge failed for ${owner}/${repo}#${prNumber} (base=${baseRef}): ${errMsg.slice(0, 200)}`);
    } catch (err) {
      log.error(`enableAutoMerge error for ${owner}/${repo}#${prNumber}`, { err });
    }
  }

  private async _postComment(
    getToken: (owner: string, repo: string) => Promise<string>,
    ctx: PendingComment,
    body: string,
  ): Promise<void> {
    try {
      const token = await getToken(ctx.owner, ctx.repo);
      const url = `https://api.github.com/repos/${ctx.owner}/${ctx.repo}/issues/${ctx.number}/comments`;
      const res = await withCircuitBreaker("github-api", () =>
        fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "protoWorkstacean/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          body: JSON.stringify({ body }),
        }),
      );
      if (!res.ok) {
        log.error(`Failed to post comment: ${res.status} ${await res.text()}`);
      } else {
        log.info(`Comment posted to ${ctx.owner}/${ctx.repo}#${ctx.number}`);
      }
    } catch (err) {
      log.error("Error posting comment", { err });
    }
  }
}
