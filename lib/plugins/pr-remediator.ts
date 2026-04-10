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
 * Rate limits are respected by the existing dispatch cooldown at the planner
 * layer — this plugin does not loop on its own.
 *
 * Env:
 *   GITHUB_TOKEN  — required for merge API calls
 *   PR_REMEDIATOR_AUTO_MERGE  — "1" enables auto-merge (default off; dry-run mode)
 */

import type { Plugin, EventBus, BusMessage, HITLRequest } from "../types.ts";
import type { WorldState } from "../types/world-state.ts";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const AUTO_MERGE_ENABLED = process.env.PR_REMEDIATOR_AUTO_MERGE === "1";

// ── Allowlist: titles / authors that may auto-merge without HITL ─────────────

const AUTO_MERGE_AUTHORS = new Set(["dependabot[bot]", "renovate[bot]"]);
const AUTO_MERGE_TITLE_PREFIXES = ["promote:", "chore(deps"];
const AUTO_MERGE_LABEL = "auto-merge";

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
  if (!GITHUB_TOKEN) return { ok: false, status: 0, error: "GITHUB_TOKEN not set" };
  try {
    const resp = await fetch(`https://api.github.com/repos/${repo}/pulls/${num}/merge`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
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
      } else if (state?.domains) {
        // Domain missing from a valid state update — drop stale cache
        this.latestPrData = null;
      }
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
      `[pr-remediator] installed — auto-merge ${AUTO_MERGE_ENABLED ? "ENABLED" : "DRY-RUN"}, token ${GITHUB_TOKEN ? "set" : "MISSING"}`,
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
  }

  // ── merge_ready ────────────────────────────────────────────────────────────

  private async _handleMergeReady(msg: BusMessage): Promise<void> {
    const ready = (this.latestPrData?.prs ?? []).filter((p) => p.readyToMerge);
    if (ready.length === 0) {
      console.log("[pr-remediator] merge_ready fired but no PRs match readyToMerge=true");
      return;
    }

    for (const pr of ready) {
      if (isAutoMergeEligible(pr)) {
        if (!AUTO_MERGE_ENABLED) {
          console.log(`[pr-remediator] DRY-RUN — would auto-merge ${pr.repo}#${pr.number} (${pr.author})`);
          continue;
        }
        const result = await ghMerge(pr.repo, pr.number);
        if (result.ok) {
          console.log(`[pr-remediator] auto-merged ${pr.repo}#${pr.number}`);
          this._publishAlert(`Auto-merged ${pr.repo}#${pr.number}`, pr);
        } else {
          console.warn(`[pr-remediator] auto-merge failed ${pr.repo}#${pr.number}: ${result.error}`);
          this._emitHitlApproval(pr, msg.correlationId, `Auto-merge failed (${result.status}): ${result.error}`);
        }
      } else {
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
      console.log(`[pr-remediator] dispatching fix_ci for ${pr.repo}#${pr.number}`);
      this._dispatchToAva(
        `PR ${pr.repo}#${pr.number} has failing CI — investigate and remediate.

Title: ${pr.title}
Branch: ${pr.baseRef} ← head ${pr.headSha.slice(0, 7)}
Author: ${pr.author}
CI status: ${pr.ciStatus}
Mergeable: ${pr.mergeable}

Read the failing workflow logs, identify the root cause, and either:
- File a bug ticket on the board with the root cause analysis
- Dispatch a fix to the owning agent via auto-mode
- Escalate to HITL if the failure is outside agent capability.`,
        "bug_triage",
        msg.correlationId,
      );
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
      console.log(`[pr-remediator] dispatching address_feedback for ${pr.repo}#${pr.number}`);
      this._dispatchToAva(
        `PR ${pr.repo}#${pr.number} has CHANGES_REQUESTED review feedback — address and resolve.

Title: ${pr.title}
Branch: ${pr.baseRef}
Author: ${pr.author}
Mergeable: ${pr.mergeable}
CI: ${pr.ciStatus}

Fetch the review comments via get_pr_feedback, address each point, and mark the review threads resolved.`,
        "bug_triage",
        msg.correlationId,
      );
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

  private _dispatchToAva(content: string, skillHint: string, parentCorrelationId: string): void {
    if (!this.bus) return;
    this.bus.publish("agent.skill.request", {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      parentId: parentCorrelationId,
      topic: "agent.skill.request",
      timestamp: Date.now(),
      payload: {
        skill: skillHint,
        skillHint,
        agentId: "ava",
        content,
      },
    });
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
