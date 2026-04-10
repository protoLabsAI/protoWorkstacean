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
import { sanitizeIssueBody } from "../sanitize.ts";
import type { SanitizationConfig } from "../sanitize.ts";
import { makeGitHubAuth } from "../github-auth.ts";
import { withCircuitBreaker } from "./circuit-breaker.ts";

// ── Config types ──────────────────────────────────────────────────────────────

interface AutoTriageConfig {
  enabled: boolean;
  orgName: string;
  events: string[];
  skillHint: string;
  /** Derived at runtime from projects.yaml — not read from github.yaml. */
  monitoredRepos: string[];
  sanitization: SanitizationConfig;
}

interface GitHubConfig {
  mentionHandle: string;
  skillHints: Record<string, string>;
  admins?: string[];
  autoTriage?: AutoTriageConfig;
}

/**
 * Derive monitoredRepos from projects.yaml (all active projects with a github field).
 * Called each time config is loaded so hot-reloads of projects.yaml are reflected.
 */
function deriveMonitoredRepos(workspaceDir: string): string[] {
  const projectsPath = join(workspaceDir, "projects.yaml");
  if (!existsSync(projectsPath)) return [];
  try {
    const raw = readFileSync(projectsPath, "utf8");
    const data = parseYaml(raw) as { projects?: { github?: string; status?: string }[] };
    return (data.projects ?? [])
      .filter(p => p.github && p.status !== "archived" && p.status !== "suspended")
      .map(p => p.github as string);
  } catch {
    return [];
  }
}

function loadConfig(workspaceDir: string): GitHubConfig {
  const configPath = join(workspaceDir, "github.yaml");
  let config: GitHubConfig;

  if (!existsSync(configPath)) {
    config = {
      mentionHandle: "@quinn",
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

  // monitoredRepos is always derived from projects.yaml at runtime
  // (never read from github.yaml) so that onboarding new projects takes effect immediately.
  if (config.autoTriage) {
    config.autoTriage.monitoredRepos = deriveMonitoredRepos(workspaceDir);
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

  if (event === "pull_request" && (payload.action === "opened" || payload.action === "synchronize")) {
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

  private server: ReturnType<typeof Bun.serve> | null = null;
  private workspaceDir: string;
  private config!: GitHubConfig;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
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

    // ── Hot-reload github.yaml and projects.yaml ──────────────────────────────
    const configPath = join(this.workspaceDir, "github.yaml");
    const projectsPath = join(this.workspaceDir, "projects.yaml");

    let reloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    const reloadConfig = () => {
      if (reloadDebounceTimer) clearTimeout(reloadDebounceTimer);
      reloadDebounceTimer = setTimeout(() => {
        this.config = loadConfig(this.workspaceDir);
        const repoCount = this.config.autoTriage?.monitoredRepos?.length ?? 0;
        console.log(`[github] Config reloaded — ${repoCount} monitored repo(s)`);
      }, 300);
    };

    // watchFile works even if the file doesn't exist yet — it will fire on creation.
    watchFile(configPath, { interval: 5_000 }, reloadConfig);
    // Also watch projects.yaml so monitoredRepos updates when projects are onboarded.
    watchFile(projectsPath, { interval: 5_000 }, reloadConfig);

    // ── Outbound: post comment back to GitHub ────────────────────────────────
    bus.subscribe("message.outbound.github.#", "github-outbound", async (msg: BusMessage) => {
      const correlationId = msg.correlationId;
      if (!correlationId) return;

      const pending = pendingComments.get(correlationId);
      if (!pending) return;
      pendingComments.delete(correlationId);

      const content = String((msg.payload as Record<string, unknown>).content ?? "").trim();
      if (!content) return;

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
    unwatchFile(join(this.workspaceDir, "projects.yaml"));
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

    const ctx = extractContext(event, payload);
    if (!ctx) return;

    // ── Auto-triage path: issues.opened/reopened in monitored repos ───────────
    // Fires when autoTriage is enabled and the issue body does NOT contain an
    // @mention (issues with @mention from admins continue via the mention path).
    if (
      config.autoTriage?.enabled &&
      event === "issues" &&
      (payload.action === "opened" || payload.action === "reopened") &&
      !ctx.body.toLowerCase().includes(config.mentionHandle.toLowerCase())
    ) {
      const repoSlug = `${ctx.owner}/${ctx.repo}`;
      if (config.autoTriage.monitoredRepos?.includes(repoSlug)) {
        this._handleAutoTriage(event, payload, ctx, config.autoTriage, bus, getToken);
        return;
      }
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

    const skillHint = config.skillHints[event];
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

  private _handleAutoTriage(
    event: string,
    payload: Record<string, unknown>,
    ctx: GitHubEventContext,
    autoTriage: AutoTriageConfig,
    bus: EventBus,
    getToken: (owner: string, repo: string) => Promise<string>,
  ): void {
    (async () => {
      try {
        const token = await getToken(ctx.owner, ctx.repo);
        const action = payload.action as string;

        // Check org membership → assign trust tier
        const isMember = await this._checkOrgMembership(autoTriage.orgName, ctx.author, token);
        const trustTier = isMember ? 3 : 1;

        let body = ctx.body;
        let quarantine: { sanitized: boolean; patternsFound: string[] } = {
          sanitized: false,
          patternsFound: [],
        };

        if (trustTier < 3) {
          const result = sanitizeIssueBody(body, autoTriage.sanitization);
          body = result.body;
          quarantine = {
            sanitized: result.patternsFound.length > 0,
            patternsFound: result.patternsFound,
          };

          // Close as spam if injection pattern count meets threshold
          if (result.patternsFound.length >= autoTriage.sanitization.spamThreshold) {
            console.log(
              `[github] Auto-triage: ${ctx.owner}/${ctx.repo}#${ctx.number} flagged as spam ` +
              `(${result.patternsFound.length} patterns) — closing`,
            );
            await this._closeIssueAsSpam(ctx.owner, ctx.repo, ctx.number, token);
            return;
          }
        }

        // Route to agent via bus
        const correlationId = crypto.randomUUID();
        pendingComments.set(correlationId, { owner: ctx.owner, repo: ctx.repo, number: ctx.number });

        const content = [
          `Auto-triage — ${event}.${action} on ${ctx.owner}/${ctx.repo}#${ctx.number}`,
          `Title: ${ctx.title}`,
          `Author: @${ctx.author} (trust tier: ${trustTier})`,
          `URL: ${ctx.url}`,
          ``,
          body,
        ].join("\n");

        const topic = `message.inbound.github.${ctx.owner}.${ctx.repo}.${event}.${ctx.number}`;
        const replyTopic = `message.outbound.github.${ctx.owner}.${ctx.repo}.${ctx.number}`;

        bus.publish(topic, {
          id: `${event}-${action}-${ctx.owner}-${ctx.repo}-${ctx.number}-${correlationId.slice(0, 8)}`,
          correlationId,
          topic,
          timestamp: Date.now(),
          payload: {
            sender: ctx.author,
            channel: `${ctx.owner}/${ctx.repo}#${ctx.number}`,
            content,
            skillHint: autoTriage.skillHint,
            trustTier,
            quarantine,
            github: {
              event,
              action,
              owner: ctx.owner,
              repo: ctx.repo,
              number: ctx.number,
              title: ctx.title,
              url: ctx.url,
            },
          },
          reply: { topic: replyTopic },
        });

        console.log(
          `[github] Auto-triage: ${event}.${action} on ${ctx.owner}/${ctx.repo}#${ctx.number} ` +
          `→ ${autoTriage.skillHint} (tier ${trustTier})`,
        );
      } catch (err) {
        console.error("[github] Auto-triage error:", err);
      }
    })();
  }

  private async _checkOrgMembership(
    orgName: string,
    username: string,
    token: string,
  ): Promise<boolean> {
    try {
      const res = await withCircuitBreaker("github-api", () =>
        fetch(
          `https://api.github.com/orgs/${orgName}/members/${username}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              "User-Agent": "protoWorkstacean/1.0",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          },
        ),
      );
      // 204 = member, 302/404 = not a member or org is private
      return res.status === 204;
    } catch {
      return false;
    }
  }

  private async _closeIssueAsSpam(
    owner: string,
    repo: string,
    number: number,
    token: string,
  ): Promise<void> {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "protoWorkstacean/1.0",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    const commentBody =
      "This issue has been automatically closed because it appears to contain content " +
      "that violates our submission guidelines. If you believe this is an error, please " +
      "open a new issue without the flagged content.";

    await withCircuitBreaker("github-api", () =>
      fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`,
        { method: "POST", headers, body: JSON.stringify({ body: commentBody }) },
      ),
    );

    await withCircuitBreaker("github-api", () =>
      fetch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
        { method: "PATCH", headers, body: JSON.stringify({ state: "closed", state_reason: "not_planned" }) },
      ),
    );
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
}
