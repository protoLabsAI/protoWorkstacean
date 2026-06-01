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
 *   QUINN_APP_ID + QUINN_APP_PRIVATE_KEY   GitHub App — comments post as quinn[bot]
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
import { withCircuitBreaker } from "./circuit-breaker.ts";
import type { ProjectRegistry } from "../../src/plugins/project-registry.ts";
import type { ReleasePublishedPayload } from "../../src/event-bus/payloads.ts";

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
 * NOT filtered — pr-remediator opens PRs as @protoquinn[bot] and those
 * should still be reviewed; self-approval is already guarded by GitHub
 * itself.
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
   * project registered in protoMaker after startup is resolvable immediately.
   */
  private _projectMetaFor(repoSlug: string): { slug: string; projectPath: string | undefined } | undefined {
    const p = this.projectRegistry.getByGithub(repoSlug);
    return p ? { slug: p.slug, projectPath: p.path } : undefined;
  }

  install(bus: EventBus): void {
    const getToken = makeGitHubAuth();
    if (!getToken) {
      console.log("[github] No auth configured (QUINN_APP_ID or GITHUB_TOKEN required) — plugin disabled");
      return;
    }

    const usingApp = !!(process.env.QUINN_APP_ID && process.env.QUINN_APP_PRIVATE_KEY);
    console.log(`[github] Auth: ${usingApp ? "GitHub App (quinn[bot])" : "PAT (GITHUB_TOKEN)"}`);

    this.config = loadConfig(this.workspaceDir);
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
    const port = parseInt(process.env.GITHUB_WEBHOOK_PORT ?? "8082", 10);

    // ── Hot-reload github.yaml ────────────────────────────────────────────────
    // Project list lives in protoMaker and is refreshed by the registry's own
    // 5-min interval — no file watcher needed for it here.
    const configPath = join(this.workspaceDir, "github.yaml");

    let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    const reloadConfig = () => {
      if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
      reloadDebounceTimer = setTimeout(() => {
        this.config = loadConfig(this.workspaceDir);
        const repoCount = this.projectRegistry.getGithubCoords().length;
        console.log(`[github] Config reloaded — ${repoCount} monitored repo(s)`);
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

      const content = String((msg.payload as Record<string, unknown>).content ?? "").trim();
      if (!content) return;
      if (/^Skill ".+" completed by \w+$/i.test(content)) return;

      await this._postComment(getToken, pending, content);
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
            console.warn("[github] Invalid webhook signature — request rejected");
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

    console.log(`[github] Webhook receiver on :${port}/webhook/github`);
  }

  uninstall(): void {
    this.server?.stop();
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

        console.log(`[github] repository.created: ${fullName} → ${topic}`);
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
        console.log(`[github] release.published: ${rel.owner}/${rel.repo} ${rel.version} → release.published`);
      }
      return;
    }

    // ── Issue opened/reopened → github.issue.opened (board-ingestion signal) ──
    // Additive, fires for EVERY opened/reopened issue regardless of @mention or
    // auto-triage routing (those member-no-mention issues otherwise produce no
    // bus event). The ProtoMakerBoardBridge subscribes and forwards issues on
    // registered project repos into protoMaker's board intake. Falls through —
    // the @mention / auto-triage handling below still runs.
    if (event === "issues" && (payload.action === "opened" || payload.action === "reopened")) {
      const issue = payload.issue as Record<string, unknown> | undefined;
      const repo = payload.repository as Record<string, unknown> | undefined;
      if (issue && repo) {
        const owner = ((repo.owner as Record<string, unknown> | undefined)?.login as string) ?? "";
        const repoName = (repo.name as string) ?? "";
        const number = issue.number as number;
        const correlationId = crypto.randomUUID();
        bus.publish("github.issue.opened", {
          id: `github-issue-${owner}-${repoName}-${number}-${correlationId.slice(0, 8)}`,
          correlationId,
          topic: "github.issue.opened",
          timestamp: Date.now(),
          payload: {
            owner,
            repo: repoName,
            number,
            action: payload.action as string,
            title: (issue.title as string) ?? "",
            body: (issue.body as string | null) ?? "",
            author: ((issue.user as Record<string, unknown> | undefined)?.login as string) ?? "",
            url: (issue.html_url as string) ?? "",
          },
          source: { interface: "github" as const },
        });
      }
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
        }
      }
    }

    // ── Terminal-CI re-review: check_suite / workflow_run completed ──────────
    // When CI finishes, resolve head SHA → open PR(s) and re-dispatch pr_review
    // so Quinn can land a formal APPROVE/REQUEST_CHANGES (guardTerminalCi will
    // pass now that all checks are terminal). Uses ci-review: dedup prefix to
    // avoid collision with commit-triggered pr-review: dedup.
    // Placed before extractContext — these events don't produce a context.
    if (event === "check_suite" && payload.action === "completed") {
      this._handleCiCompletion(payload, "check_suite", bus, getToken)
        .catch((err) => console.error("[github] CI-completion (check_suite) error:", err));
      return;
    }
    if (event === "workflow_run" && payload.action === "completed") {
      this._handleCiCompletion(payload, "workflow_run", bus, getToken)
        .catch((err) => console.error("[github] CI-completion (workflow_run) error:", err));
      return;
    }

    const ctx = extractContext(event, payload);
    if (!ctx) return;

    // ── Self-cascade guard ─────────────────────────────────────────────────────
    // Drop issue + issue_comment + pull_request_review_comment events authored
    // by our own agent bots before they reach auto-triage or the @mention path.
    // Without this, Quinn files an issue → GitHub webhook → bug_triage →
    // Quinn files another issue → infinite cascade (protoWorkstacean#556 ate
    // protoMaker with 23 duplicate triage issues in 60s). pull_request events
    // are intentionally NOT filtered here — pr-remediator opens legitimate
    // bot-authored PRs that should still be reviewed; GitHub's self-approval
    // check already prevents same-account approvals.
    if (
      (event === "issues" || event === "issue_comment" || event === "pull_request_review_comment") &&
      isAgentBotActor(ctx.author)
    ) {
      console.log(
        `[github] Dropping ${event}.${payload.action} on ${ctx.owner}/${ctx.repo}#${ctx.number} — ` +
        `authored by agent bot ${ctx.author} (self-cascade guard, see #556)`,
      );
      return;
    }

    // Issues on registered project repos are owned by protoMaker, not
    // workstacean: ProtoMakerBoardBridge forwards github.issue.opened into
    // protoMaker's board intake (ADR-0001). Workstacean does not auto-triage
    // issues — that single ownership boundary (registry membership) is what
    // keeps an issue from being double-handled (see JOSH-392). Admins who want
    // workstacean to act on a specific issue still use the @mention path below.

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
      if (login === "protoquinn" || login === "protoquinn[bot]") {
        this._handleAutoReview(event, payload, ctx, bus, getToken, { skipDedup: true });
      }
      return;
    }

    // ── @mention path (existing, unchanged) ──────────────────────────────────
    if (!ctx.body.toLowerCase().includes(config.mentionHandle.toLowerCase())) return;

    if (config.admins?.length && !config.admins.some(a => a.toLowerCase() === ctx.author.toLowerCase())) {
      console.log(`[github] ${event} from @${ctx.author} ignored — not in admins list`);
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
      if (!res.ok) console.error(`[github] reaction failed ${res.status}: ${await res.text()}`);
    })().catch(err => console.error("[github] reaction error:", err));

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

    console.log(`[github] ${event} on ${ctx.owner}/${ctx.repo}#${ctx.number} → ${skillHint ?? "default"}`);
  }

  /** Tracks recently-dispatched (owner/repo#number) to suppress duplicate webhook deliveries. */
  private recentDispatches = new Map<string, number>();
  private static readonly DEDUP_WINDOW_MS = 60_000;

  private _handleAutoReview(
    event: string,
    payload: Record<string, unknown>,
    ctx: GitHubEventContext,
    bus: EventBus,
    getToken: (owner: string, repo: string) => Promise<string>,
    opts: { skipDedup: boolean; dedupKey?: string } = { skipDedup: false },
  ): void {
    const action = payload.action as string;
    const dedupKey = opts.dedupKey ?? `pr-review:${ctx.owner}/${ctx.repo}#${ctx.number}`;
    if (!opts.skipDedup) {
      const lastDispatched = this.recentDispatches.get(dedupKey);
      if (lastDispatched && Date.now() - lastDispatched < GitHubPlugin.DEDUP_WINDOW_MS) {
        console.log(`[github] Auto-review: skipping duplicate ${dedupKey} (dispatched ${Date.now() - lastDispatched}ms ago)`);
        return;
      }
    }
    this.recentDispatches.set(dedupKey, Date.now());

    const pr = payload.pull_request as Record<string, unknown>;
    const isDraft = pr?.draft as boolean;
    if (isDraft) {
      console.log(`[github] Auto-review: skipping draft PR ${ctx.owner}/${ctx.repo}#${ctx.number}`);
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

    console.log(`[github] Auto-review: ${ctx.owner}/${ctx.repo}#${ctx.number} (${action}) → pr_review`);

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
        console.warn(
          `[github] Auto-review: leading-comment post failed for ${ctx.owner}/${ctx.repo}#${ctx.number}: ${err instanceof Error ? err.message : err}`,
        );
      });
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
        console.error(`[github] Failed to post comment: ${res.status} ${await res.text()}`);
      } else {
        console.log(`[github] Comment posted to ${ctx.owner}/${ctx.repo}#${ctx.number}`);
      }
    } catch (err) {
      console.error("[github] Error posting comment:", err);
    }
  }

  /** Terminal CI conclusions — null means "still running". */
  private static readonly TERMINAL_CONCLUSIONS = new Set([
    "success", "failure", "neutral", "skipped", "cancelled", "timed_out", "action_required",
  ]);

  private _isTerminalConclusion(conclusion: unknown): boolean {
    return typeof conclusion === "string" && GitHubPlugin.TERMINAL_CONCLUSIONS.has(conclusion);
  }

  /**
   * Resolve open PR(s) at a given head SHA.
   * Calls GET /repos/{owner}/{repo}/commits/{sha}/pulls/open
   */
  private async _resolvePrsForSha(
    getToken: (owner: string, repo: string) => Promise<string>,
    owner: string,
    repo: string,
    sha: string,
  ): Promise<Array<{ number: number; sha: string }>> {
    try {
      const token = await getToken(owner, repo);
      const url = `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/pulls/open`;
      const res = await withCircuitBreaker("github-api", () =>
        fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "protoWorkstacean/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }),
      );
      if (!res.ok) {
        console.warn(`[github] CI-completion: SHA→PR lookup failed ${res.status} for ${owner}/${repo}@${sha}`);
        return [];
      }
      const prs = (await res.json()) as Array<Record<string, unknown>>;
      return prs.map((pr) => ({
        number: pr.number as number,
        sha: (pr.head as Record<string, unknown>)?.sha as string,
      }));
    } catch (err) {
      console.warn(`[github] CI-completion: SHA→PR lookup error for ${owner}/${repo}@${sha}:`, err);
      return [];
    }
  }

  /**
   * Check whether Quinn already has a formal (non-COMMENT) review on the PR.
   * Returns true if APPROVED or CHANGES_REQUESTED review exists by protoquinn[bot].
   */
  private async _hasFormalQuinnReview(
    getToken: (owner: string, repo: string) => Promise<string>,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<boolean> {
    try {
      const token = await getToken(owner, repo);
      const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
      const res = await withCircuitBreaker("github-api", () =>
        fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "protoWorkstacean/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }),
      );
      if (!res.ok) {
        console.warn(`[github] CI-completion: review lookup failed ${res.status} for ${owner}/${repo}#${prNumber}`);
        return false;
      }
      const reviews = (await res.json()) as Array<Record<string, unknown>>;
      const quinnReview = reviews.find((r) => {
        const login = ((r.user as Record<string, unknown> | undefined)?.login as string | undefined)?.toLowerCase();
        return login === "protoquinn" || login === "protoquinn[bot]";
      });
      const quinnState = (quinnReview ?? {}).state as string | undefined;
      return quinnState === "APPROVED" || quinnState === "CHANGES_REQUESTED";
    } catch (err) {
      console.warn(`[github] CI-completion: review lookup error for ${owner}/${repo}#${prNumber}:`, err);
      return false;
    }
  }

  /**
   * Handle CI-completion webhook events (check_suite.completed / workflow_run.completed).
   * Resolves head SHA → open PR(s) and re-dispatches pr_review through _handleAutoReview.
   */
  private async _handleCiCompletion(
    payload: Record<string, unknown>,
    eventType: "check_suite" | "workflow_run",
    bus: EventBus,
    getToken: (owner: string, repo: string) => Promise<string>,
  ): Promise<void> {
    const ciObject = eventType === "check_suite"
      ? payload.check_suite as Record<string, unknown> | undefined
      : payload.workflow_run as Record<string, unknown> | undefined;

    if (!ciObject) {
      console.warn(`[github] CI-completion: missing ${eventType} object in payload`);
      return;
    }

    const headSha = ciObject.head_sha as string | undefined;
    const repo = payload.repository as Record<string, unknown> | undefined;
    const owner = ((repo?.owner as Record<string, unknown> | undefined)?.login as string) ?? "";
    const repoName = (repo?.name as string) ?? "";

    if (!headSha || !owner || !repoName) {
      console.warn(`[github] CI-completion: missing head_sha or repo info (${eventType})`);
      return;
    }

    // Only trigger on terminal conclusions (null = still running)
    const conclusion = ciObject.conclusion as string | null | undefined;
    if (!this._isTerminalConclusion(conclusion)) {
      console.log(`[github] CI-completion: non-terminal conclusion "${conclusion}" — skipping (${eventType})`);
      return;
    }

    // Resolve SHA → open PRs
    const prs = await this._resolvePrsForSha(getToken, owner, repoName, headSha);
    if (prs.length === 0) {
      console.log(`[github] CI-completion: no open PRs at ${owner}/${repoName}@${headSha.slice(0, 7)}`);
      return;
    }

    for (const pr of prs) {
      // Stale SHA guard — skip if CI result is for a superseded commit
      if (pr.sha !== headSha) {
        console.log(`[github] CI-completion: stale SHA for ${owner}/${repoName}#${pr.number} (expected ${headSha.slice(0, 7)}, got ${pr.sha.slice(0, 7)})`);
        continue;
      }

      // Skip if Quinn already has a formal review
      if (await this._hasFormalQuinnReview(getToken, owner, repoName, pr.number)) {
        console.log(`[github] CI-completion: Quinn already has formal review on ${owner}/${repoName}#${pr.number} — skipping`);
        continue;
      }

      // Fetch PR details to build context
      const prDetail = await this._fetchPrDetail(getToken, owner, repoName, pr.number);
      if (!prDetail) continue;

      const ctx: GitHubEventContext = {
        owner,
        repo: repoName,
        number: pr.number,
        title: prDetail.title as string,
        url: prDetail.html_url as string,
        body: (prDetail.body as string | null) ?? "",
        author: ((prDetail.user as Record<string, unknown> | undefined)?.login as string) ?? "",
      };

      const syntheticPayload: Record<string, unknown> = {
        action: "ci_completed",
        pull_request: {
          draft: prDetail.draft,
          head: { sha: headSha },
          title: ctx.title,
          html_url: ctx.url,
          body: ctx.body,
          user: prDetail.user,
        },
      };

      this._handleAutoReview(
        eventType,
        syntheticPayload,
        ctx,
        bus,
        getToken,
        { skipDedup: true, dedupKey: `ci-review:${owner}/${repoName}#${pr.number}` },
      );
    }
  }

  /** Fetch full PR detail from GitHub API. */
  private async _fetchPrDetail(
    getToken: (owner: string, repo: string) => Promise<string>,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<Record<string, unknown> | null> {
    try {
      const token = await getToken(owner, repo);
      const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
      const res = await withCircuitBreaker("github-api", () =>
        fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "protoWorkstacean/1.0",
            "X-GitHub-Api-Version": "2022-11-28",
          },
        }),
      );
      if (!res.ok) {
        console.warn(`[github] CI-completion: PR detail fetch failed ${res.status} for ${owner}/${repo}#${prNumber}`);
        return null;
      }
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      console.warn(`[github] CI-completion: PR detail fetch error for ${owner}/${repo}#${prNumber}:`, err);
      return null;
    }
  }
}
