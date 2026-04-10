/**
 * PrRemediatorPlugin — closes the loop on stuck PRs surfaced by the
 * pr_pipeline domain.
 *
 * Subscribes to:
 *   world.state.updated              — tracks latest pr_pipeline snapshot
 *   pr.remediate.merge_ready         — dispatched by action on pr.mergeable_flushed violation
 *   pr.remediate.fix_ci              — dispatched by action on pr.no_failing_checks violation
 *   pr.remediate.address_feedback    — dispatched by action on pr.no_changes_requested violation
 *
 * For each pr_pipeline.data.prs entry matching the remediation criteria:
 *
 *   merge_ready:
 *     - If title/author matches auto-merge allowlist (dependabot, promote:,
 *       labeled "auto-merge") → POST /repos/{repo}/pulls/{num}/merge
 *     - Otherwise → publish hitl.request.pr.merge.{id} with an approval card
 *
 *   fix_ci:
 *     - Publish agent.skill.request to Ava with skillHint="bug_triage" and
 *       the failing PR context (repo, number, ciStatus, headSha).
 *
 *   address_feedback:
 *     - Publish agent.skill.request to Ava with skillHint="bug_triage"
 *       including the CHANGES_REQUESTED review feedback. (Ava routes to the
 *       owning agent or files a bug.)
 *
 * Loop protection:
 *   A single PR can be dispatched at most MAX_ATTEMPTS_PER_PR times, with a
 *   cooldown of ATTEMPT_COOLDOWN_MS between attempts. While a remediation is
 *   in-flight (tracked via correlationId → agent.skill.response subscription),
 *   the same (PR, kind) tuple will not be re-dispatched. This prevents the
 *   runaway cascade that can otherwise occur when the world-state poller keeps
 *   observing the same failing PRs before the previous remediation agent has
 *   finished.
 *
 * Env:
 *   QUINN_APP_ID / QUINN_APP_PRIVATE_KEY — GitHub App creds (preferred — has
 *     pull_requests:write scoped per-installation)
 *   GITHUB_TOKEN                         — PAT fallback when App creds absent
 *   PR_REMEDIATOR_AUTO_MERGE             — "1" enables auto-merge (default
 *     off; dry-run mode just logs)
 */

import type { Plugin, EventBus, BusMessage, HITLRequest } from "../types.ts";
import type { WorldState } from "../types/world-state.ts";
import { makeGitHubAuth } from "../github-auth.ts";

const AUTO_MERGE_ENABLED = process.env.PR_REMEDIATOR_AUTO_MERGE === "1";
// Resolved at install() time — null when no GitHub credentials are present.
const getGithubToken = makeGitHubAuth();

// ── Loop protection ─────────────────────────────────────────────────────────
// A remediation that hasn't completed in this window is assumed dead (the
// agent crashed, the bus dropped the reply, etc.) and the slot is freed.
const IN_FLIGHT_TTL_MS = 15 * 60 * 1000;
// Minimum wait between consecutive attempts on the same PR+kind. Stops the
// world-state poller from triggering re-dispatches faster than agents can work.
const ATTEMPT_COOLDOWN_MS = 5 * 60 * 1000;
// After this many attempts on the same PR+kind, the plugin gives up and
// escalates to HITL once. Further triggers are silently ignored until a
// human clears the entry (by the PR leaving pr_pipeline, e.g. merged/closed).
const MAX_ATTEMPTS_PER_PR = 3;

type RemediationKind = "fix_ci" | "address_feedback" | "merge_ready";

interface InFlightEntry {
  kind: RemediationKind;
  /** Timestamp the most recent dispatch was issued. */
  startedAt: number;
  /**
   * Timestamp the most recent dispatch completed (skill response received).
   * Undefined while the attempt is still in-flight or if the attempt TTL'd out.
   */
  completedAt?: number;
  correlationId: string;
  attempts: number;
  /** Terminal state — further triggers are silently ignored until the PR leaves the pipeline. */
  exhausted: boolean;
}

// ── Allowlist: titles / authors that may auto-merge without HITL ─────────────

const AUTO_MERGE_AUTHORS = new Set(["dependabot[bot]", "renovate[bot]"]);
const AUTO_MERGE_TITLE_PREFIXES = ["promote:", "chore(deps"];
const AUTO_MERGE_LABEL = "auto-merge";

/**
 * Derive the workstacean/ava project slug from a GitHub `owner/repo` string.
 * Matches the slugs in workspace/projects.yaml: lowercase repo name with dots
 * replaced by dashes (e.g. `rabbit-hole.io` → `rabbit-hole-io`).
 *
 * Returns empty string if the repo slug is malformed — caller should fall
 * back to including the full `owner/repo` in the message content so Ava
 * can disambiguate via `list_projects` if needed.
 */
function deriveProjectSlug(repo: string): string {
  const parts = repo.split("/");
  if (parts.length !== 2 || !parts[1]) return "";
  return parts[1].toLowerCase().replace(/\./g, "-");
}

// ── Domain data shape (mirrors src/api/github.ts handleGetPrPipeline) ────────

interface PrDomainEntry {
  repo: string;
  number: number;
  title: string;
  headSha: string;
  author: string;
  baseRef: string;
  mergeable: "clean" | "dirty" | "blocked" | "unknown";
  ciStatus: "pass" | "fail" | "pending" | "none";
  reviewState: "approved" | "changes_requested" | "pending" | "none";
  isDraft: boolean;
  readyToMerge: boolean;
  labels: string[];
}

interface PrDomainData {
  prs: PrDomainEntry[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isAutoMergeEligible(pr: PrDomainEntry): boolean {
  if (AUTO_MERGE_AUTHORS.has(pr.author)) return true;
  if (pr.labels.includes(AUTO_MERGE_LABEL)) return true;
  for (const prefix of AUTO_MERGE_TITLE_PREFIXES) {
    if (pr.title.startsWith(prefix)) return true;
  }
  return false;
}

async function ghMerge(repo: string, num: number): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!getGithubToken) return { ok: false, status: 0, error: "no GitHub credentials (QUINN_APP_* or GITHUB_TOKEN)" };
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) return { ok: false, status: 0, error: `malformed repo slug "${repo}"` };
  try {
    const token = await getGithubToken(owner, repoName);
    const resp = await fetch(`https://api.github.com/repos/${repo}/pulls/${num}/merge`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ merge_method: "squash" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (resp.ok) return { ok: true, status: resp.status };
    const body = await resp.text().catch(() => "");
    return { ok: false, status: resp.status, error: body.slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 0, error: String(err) };
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export class PrRemediatorPlugin implements Plugin {
  readonly name = "pr-remediator";
  readonly description = "Closes the GOAP loop on stuck PRs — auto-merges eligible titles, escalates others to HITL";
  readonly capabilities = ["pr-merge", "pr-feedback-dispatch", "hitl-emit"];

  private bus?: EventBus;
  private readonly subscriptionIds: string[] = [];
  private latestPrData: PrDomainData | null = null;
  /** Map correlationId → PR identity, so HITL response can find the PR to merge. */
  private readonly pendingApprovals = new Map<string, { repo: string; number: number; title: string }>();
  /** Map `${repo}#${number}:${kind}` → in-flight dispatch metadata. */
  private readonly inFlight = new Map<string, InFlightEntry>();

  install(bus: EventBus): void {
    this.bus = bus;

    // Track the latest pr_pipeline snapshot from the world state engine.
    // If a later update omits pr_pipeline (domain dropped / collector failed),
    // clear the cache so stale PRs don't trigger bogus remediation.
    this.subscriptionIds.push(bus.subscribe("world.state.updated", this.name, (msg) => {
      const state = msg.payload as WorldState | undefined;
      const domain = state?.domains?.pr_pipeline;
      if (domain?.data) {
        this.latestPrData = domain.data as PrDomainData;
        // Drop in-flight entries for PRs no longer in the pipeline (merged/closed).
        // This lets exhausted entries clear naturally without a timer.
        this._pruneInFlight();
      } else if (state?.domains) {
        // Domain missing from a valid state update — drop stale cache
        this.latestPrData = null;
      }
    }));

    // Correlate skill responses back to the in-flight entry and clear the slot.
    // The dispatch topic is `agent.skill.response.{correlationId}` — matching
    // with a trailing `#` wildcard subscribes to every response without seeing
    // unrelated bus traffic.
    this.subscriptionIds.push(bus.subscribe("agent.skill.response.#", this.name, (msg) => {
      this._clearInFlightByCorrelationId(msg.correlationId);
    }));

    // Remediation triggers
    this.subscriptionIds.push(bus.subscribe("pr.remediate.merge_ready", this.name, (msg) => {
      void this._handleMergeReady(msg);
    }));
    this.subscriptionIds.push(bus.subscribe("pr.remediate.fix_ci", this.name, (msg) => {
      void this._handleFixCi(msg);
    }));
    this.subscriptionIds.push(bus.subscribe("pr.remediate.address_feedback", this.name, (msg) => {
      void this._handleAddressFeedback(msg);
    }));

    // HITL response handler — fires when a human approves/rejects via Discord.
    // On approve, execute the merge the plugin was waiting on.
    this.subscriptionIds.push(bus.subscribe("hitl.response.pr.merge.#", this.name, (msg) => {
      void this._handleHitlResponse(msg);
    }));

    console.log(
      `[pr-remediator] installed — auto-merge ${AUTO_MERGE_ENABLED ? "ENABLED" : "DRY-RUN"}, auth ${getGithubToken ? "configured" : "MISSING"}`,
    );
  }

  uninstall(): void {
    if (this.bus) {
      for (const id of this.subscriptionIds) this.bus.unsubscribe(id);
    }
    this.subscriptionIds.length = 0;
    this.bus = undefined;
    this.latestPrData = null;
    this.pendingApprovals.clear();
    this.inFlight.clear();
  }

  // ── Loop protection helpers ────────────────────────────────────────────────

  private _inFlightKey(repo: string, number: number, kind: RemediationKind): string {
    return `${repo}#${number}:${kind}`;
  }

  /**
   * Decide whether a new dispatch for (PR, kind) should proceed.
   * Returns a reason string when blocked so callers can log it.
   *
   * State machine:
   *   no entry             → allow
   *   exhausted            → reject forever (until PR leaves pipeline)
   *   in-flight & < TTL    → reject (previous attempt still running)
   *   in-flight & ≥ TTL    → attempt counted; allow if under cap, else exhaust
   *   completed & < cooldown → reject (cooldown)
   *   completed & ≥ cooldown → allow if under cap, else exhaust
   */
  private _shouldDispatch(
    repo: string,
    number: number,
    kind: RemediationKind,
  ): { ok: true } | { ok: false; reason: string } {
    const key = this._inFlightKey(repo, number, kind);
    const entry = this.inFlight.get(key);
    if (!entry) return { ok: true };

    if (entry.exhausted) {
      return { ok: false, reason: `exhausted after ${entry.attempts} attempts` };
    }

    const now = Date.now();

    if (entry.completedAt === undefined) {
      // In-flight — the previous dispatch hasn't reported back yet.
      const age = now - entry.startedAt;
      if (age < IN_FLIGHT_TTL_MS) {
        return { ok: false, reason: `in-flight (age ${Math.round(age / 1000)}s, correlationId ${entry.correlationId})` };
      }
      // TTL expired without response — treat as a silent failure and fall
      // through to the attempt-cap check below.
    } else {
      // Previous dispatch reported back — enforce cooldown between attempts.
      const sinceCompleted = now - entry.completedAt;
      if (sinceCompleted < ATTEMPT_COOLDOWN_MS) {
        return { ok: false, reason: `cooldown (completed ${Math.round(sinceCompleted / 1000)}s ago)` };
      }
    }

    if (entry.attempts >= MAX_ATTEMPTS_PER_PR) {
      entry.exhausted = true;
      return { ok: false, reason: `exhausted after ${entry.attempts} attempts` };
    }
    return { ok: true };
  }

  private _recordDispatch(
    repo: string,
    number: number,
    kind: RemediationKind,
    correlationId: string,
  ): void {
    const key = this._inFlightKey(repo, number, kind);
    const prior = this.inFlight.get(key);
    this.inFlight.set(key, {
      kind,
      startedAt: Date.now(),
      completedAt: undefined,
      correlationId,
      attempts: (prior?.attempts ?? 0) + 1,
      exhausted: false,
    });
  }

  /**
   * Mark the entry matching this correlationId as completed. The entry stays
   * in the map until either (a) the cooldown window lets a new attempt
   * through, (b) the attempt cap is reached and it becomes exhausted, or
   * (c) the PR leaves pr_pipeline and _pruneInFlight drops it.
   */
  private _clearInFlightByCorrelationId(correlationId: string): void {
    for (const entry of this.inFlight.values()) {
      if (entry.correlationId === correlationId) {
        entry.completedAt = Date.now();
        return;
      }
    }
  }

  /** Drop in-flight entries whose PR is no longer in the pipeline (merged/closed). */
  private _pruneInFlight(): void {
    const activePrs = new Set(
      (this.latestPrData?.prs ?? []).map((p) => `${p.repo}#${p.number}`),
    );
    for (const key of this.inFlight.keys()) {
      const prId = key.split(":")[0];
      if (prId && !activePrs.has(prId)) {
        this.inFlight.delete(key);
      }
    }
  }

  // ── merge_ready ────────────────────────────────────────────────────────────

  private async _handleMergeReady(msg: BusMessage): Promise<void> {
    const ready = (this.latestPrData?.prs ?? []).filter((p) => p.readyToMerge);
    if (ready.length === 0) {
      console.log("[pr-remediator] merge_ready fired but no PRs match readyToMerge=true");
      return;
    }

    for (const pr of ready) {
      const gate = this._shouldDispatch(pr.repo, pr.number, "merge_ready");
      if (!gate.ok) {
        console.log(`[pr-remediator] skip merge_ready ${pr.repo}#${pr.number}: ${gate.reason}`);
        continue;
      }

      if (isAutoMergeEligible(pr)) {
        if (!AUTO_MERGE_ENABLED) {
          console.log(`[pr-remediator] DRY-RUN — would auto-merge ${pr.repo}#${pr.number} (${pr.author})`);
          continue;
        }
        // Claim the slot before the network call so a concurrent trigger
        // can't race into the same merge. The correlationId is synthetic
        // since no skill dispatch happens — the entry clears on pipeline prune.
        this._recordDispatch(pr.repo, pr.number, "merge_ready", `merge-${crypto.randomUUID()}`);
        const result = await ghMerge(pr.repo, pr.number);
        if (result.ok) {
          console.log(`[pr-remediator] auto-merged ${pr.repo}#${pr.number}`);
          this._publishAlert(`Auto-merged ${pr.repo}#${pr.number}`, pr);
        } else {
          console.warn(`[pr-remediator] auto-merge failed ${pr.repo}#${pr.number}: ${result.error}`);
          this._emitHitlApproval(pr, msg.correlationId, `Auto-merge failed (${result.status}): ${result.error}`);
        }
      } else {
        this._recordDispatch(pr.repo, pr.number, "merge_ready", `hitl-${crypto.randomUUID()}`);
        this._emitHitlApproval(pr, msg.correlationId);
      }
    }
  }

  // ── fix_ci ─────────────────────────────────────────────────────────────────

  private _handleFixCi(msg: BusMessage): void {
    const failing = (this.latestPrData?.prs ?? []).filter((p) => p.ciStatus === "fail");
    if (failing.length === 0) {
      console.log("[pr-remediator] fix_ci fired but no PRs match ciStatus=fail");
      return;
    }
    for (const pr of failing) {
      const gate = this._shouldDispatch(pr.repo, pr.number, "fix_ci");
      if (!gate.ok) {
        console.log(`[pr-remediator] skip fix_ci ${pr.repo}#${pr.number}: ${gate.reason}`);
        continue;
      }
      const projectSlug = deriveProjectSlug(pr.repo);
      console.log(`[pr-remediator] dispatching fix_ci for ${pr.repo}#${pr.number} (slug: ${projectSlug})`);
      const correlationId = this._dispatchToAva(
        `PR ${pr.repo}#${pr.number} has failing CI on the **${projectSlug}** project — investigate and dispatch a fix.

Project: ${projectSlug}  (github: ${pr.repo})
PR: #${pr.number} — ${pr.title}
Branch: ${pr.baseRef} ← head ${pr.headSha.slice(0, 7)}
Author: ${pr.author}
CI status: ${pr.ciStatus}
Mergeable: ${pr.mergeable}

REQUIRED STEPS — execute in order, do not stop until all are done:

1. Call \`check_pr_status\` with projectPath for the "${projectSlug}" project to confirm the failure and read the failing workflow name(s).
2. Call \`get_pr_feedback\` to fetch any review comments and check logs.
3. Call \`create_feature\` on the "${projectSlug}" project (NOT the default project — you must pass the correct projectPath) with a root-cause analysis and a clear "fix this" title.
4. Call \`start_auto_mode\` on the "${projectSlug}" project so an agent immediately picks up the new feature and begins work.
5. Reply with a one-line summary: "Filed feature <id> on ${projectSlug}, auto-mode started."

Do NOT just file the ticket and stop — the ticket must be followed by \`start_auto_mode\` or nothing will actually happen. Only escalate via reply if one of the tool calls returns an unrecoverable error.`,
        "bug_triage",
        msg.correlationId,
        { projectSlug, projectRepo: pr.repo, prNumber: pr.number },
      );
      if (correlationId) {
        this._recordDispatch(pr.repo, pr.number, "fix_ci", correlationId);
      }
    }
  }

  // ── address_feedback ───────────────────────────────────────────────────────

  private _handleAddressFeedback(msg: BusMessage): void {
    const blocked = (this.latestPrData?.prs ?? []).filter((p) => p.reviewState === "changes_requested");
    if (blocked.length === 0) {
      console.log("[pr-remediator] address_feedback fired but no PRs match reviewState=changes_requested");
      return;
    }
    for (const pr of blocked) {
      const gate = this._shouldDispatch(pr.repo, pr.number, "address_feedback");
      if (!gate.ok) {
        console.log(`[pr-remediator] skip address_feedback ${pr.repo}#${pr.number}: ${gate.reason}`);
        continue;
      }
      const projectSlug = deriveProjectSlug(pr.repo);
      console.log(`[pr-remediator] dispatching address_feedback for ${pr.repo}#${pr.number} (slug: ${projectSlug})`);
      const correlationId = this._dispatchToAva(
        `PR ${pr.repo}#${pr.number} on the **${projectSlug}** project has CHANGES_REQUESTED review feedback — address and resolve.

Project: ${projectSlug}  (github: ${pr.repo})
PR: #${pr.number} — ${pr.title}
Branch: ${pr.baseRef}
Author: ${pr.author}
Mergeable: ${pr.mergeable}
CI: ${pr.ciStatus}

REQUIRED STEPS — execute in order, do not stop until all are done:

1. Call \`get_pr_feedback\` for PR #${pr.number} on the "${projectSlug}" project to fetch every unresolved review thread.
2. Call \`create_feature\` on the "${projectSlug}" project (NOT the default project — you must pass the correct projectPath) with a summary of the feedback and a title like "Address review on PR #${pr.number}".
3. Call \`start_auto_mode\` on the "${projectSlug}" project so an agent immediately picks up the new feature.
4. Reply with a one-line summary: "Filed feature <id> on ${projectSlug}, auto-mode started."

Do NOT just file the ticket and stop — the ticket must be followed by \`start_auto_mode\` or nothing will actually happen. Only escalate via reply if a tool call returns an unrecoverable error.`,
        "bug_triage",
        msg.correlationId,
        { projectSlug, projectRepo: pr.repo, prNumber: pr.number },
      );
      if (correlationId) {
        this._recordDispatch(pr.repo, pr.number, "address_feedback", correlationId);
      }
    }
  }

  // ── outbound helpers ───────────────────────────────────────────────────────

  private _emitHitlApproval(pr: PrDomainEntry, parentCorrelationId: string, note?: string): void {
    if (!this.bus) return;
    const correlationId = crypto.randomUUID();
    const replyTopic = `hitl.response.pr.merge.${correlationId}`;
    const request: HITLRequest = {
      type: "hitl_request",
      correlationId,
      title: `Merge ${pr.repo}#${pr.number}?`,
      summary: [
        `**${pr.title}**`,
        `Author: ${pr.author}`,
        `Branch: ${pr.baseRef}`,
        `CI: ${pr.ciStatus} · Review: ${pr.reviewState} · Mergeable: ${pr.mergeable}`,
        note ? `\n⚠ ${note}` : "",
        `\nhttps://github.com/${pr.repo}/pull/${pr.number}`,
      ].filter(Boolean).join("\n"),
      options: ["approve", "reject"],
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      replyTopic,
    };
    // Record the pending approval so the response handler can act on it
    this.pendingApprovals.set(correlationId, {
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
    });
    this.bus.publish(`hitl.request.pr.merge.${correlationId}`, {
      id: crypto.randomUUID(),
      correlationId,
      parentId: parentCorrelationId,
      topic: `hitl.request.pr.merge.${correlationId}`,
      timestamp: Date.now(),
      payload: request,
    });
    console.log(`[pr-remediator] HITL approval requested for ${pr.repo}#${pr.number}`);
  }

  /**
   * Handle a human decision from HITL. Expected payload shape:
   *   { type: "hitl_response", correlationId, decision: "approve" | "reject", ... }
   * On "approve" we execute the merge; on "reject" we drop the pending entry.
   */
  private async _handleHitlResponse(msg: BusMessage): Promise<void> {
    const response = msg.payload as {
      type?: string;
      correlationId?: string;
      decision?: string;
      decidedBy?: string;
    };
    if (response.type !== "hitl_response" || !response.correlationId) return;

    const pending = this.pendingApprovals.get(response.correlationId);
    if (!pending) {
      console.log(`[pr-remediator] HITL response ${response.correlationId} — no matching pending PR (expired or duplicate)`);
      return;
    }
    this.pendingApprovals.delete(response.correlationId);

    if (response.decision !== "approve") {
      console.log(`[pr-remediator] HITL rejected ${pending.repo}#${pending.number} by ${response.decidedBy ?? "unknown"}`);
      return;
    }

    if (!AUTO_MERGE_ENABLED) {
      console.log(`[pr-remediator] DRY-RUN — HITL approved ${pending.repo}#${pending.number}, would merge`);
      return;
    }

    const result = await ghMerge(pending.repo, pending.number);
    if (result.ok) {
      console.log(`[pr-remediator] HITL-approved merge succeeded ${pending.repo}#${pending.number}`);
    } else {
      console.warn(`[pr-remediator] HITL-approved merge FAILED ${pending.repo}#${pending.number}: ${result.error}`);
    }
  }

  private _dispatchToAva(
    content: string,
    skillHint: string,
    parentCorrelationId: string,
    extraMeta?: Record<string, unknown>,
  ): string | undefined {
    if (!this.bus) return undefined;
    const correlationId = crypto.randomUUID();
    // NOTE: skill-dispatcher targets by `payload.meta.agentId`, NOT top-level
    // `payload.agentId`. Both Ava (a2a) and Quinn (proto-sdk) register
    // bug_triage, and without explicit targeting the dispatcher picks the
    // first-registered executor (Quinn — who is read-only and exits 53).
    //
    // A2AExecutor spreads the full payload into the JSON-RPC message metadata
    // (src/executor/executors/a2a-executor.ts line 58 — `...req.payload`), so
    // anything in extraMeta reaches Ava's A2A handler as message.metadata.
    this.bus.publish("agent.skill.request", {
      id: crypto.randomUUID(),
      correlationId,
      parentId: parentCorrelationId,
      topic: "agent.skill.request",
      timestamp: Date.now(),
      payload: {
        skill: skillHint,
        content,
        meta: { agentId: "ava", skillHint },
        ...(extraMeta ?? {}),
      },
    });
    return correlationId;
  }

  private _publishAlert(text: string, pr: PrDomainEntry): void {
    if (!this.bus) return;
    this.bus.publish("message.outbound.discord.alert", {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: "message.outbound.discord.alert",
      timestamp: Date.now(),
      payload: {
        actionId: "pr.remediate.merge_ready",
        goalId: "pr.mergeable_flushed",
        meta: {
          severity: "low",
          agentId: "pr-remediator",
          extra: { text, prRepo: pr.repo, prNumber: pr.number },
        },
      },
    });
  }
}
