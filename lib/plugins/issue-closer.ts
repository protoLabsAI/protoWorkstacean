/**
 * IssueCloserPlugin — closes the originating GitHub issue when its feature ships.
 *
 * The portfolio pipeline files GitHub issues as the spine (Ava fans out per-repo
 * issues → protoMaker ingests them as features → execution). protoMaker emits
 * `feature.completed` on `done`, echoing the originating `githubIssueNumber` +
 * `repo` (protoMaker PR for that field). Without this consumer the work ships
 * but the issue stays open forever — issues created on an event, never cleared
 * on resolve, the exact stale-pile-up shape behind this P1.
 *
 * This is the GitHub analog of the Linear close-the-loop. It subscribes to
 * `feature.completed` and closes `repo#githubIssueNumber` with a comment linking
 * the shipped PR. Best-effort: a close failure is logged loudly but never
 * disturbs other consumers (e.g. the Discord feature-notifier on the same event).
 *
 * `feature.failed` is intentionally NOT handled — a failed/escalated feature's
 * issue must stay open for attention.
 */

import type { Plugin, EventBus, BusMessage } from "../types.ts";
import { closeIssue as defaultCloseIssue } from "../github-issues.ts";
import { logger } from "../log.ts";

const log = logger("issue-closer");

interface FeatureCompletedPayload {
  featureId?: string;
  featureTitle?: string;
  githubIssueNumber?: number;
  repo?: string; // "owner/name"
  prNumber?: number;
}

type CloseFn = (
  owner: string,
  name: string,
  issueNumber: number,
  opts: { comment?: string; reason?: "completed" | "not_planned" },
) => Promise<void>;

export class IssueCloserPlugin implements Plugin {
  readonly name = "issue-closer";
  readonly description = "Closes the originating GitHub issue when its feature ships (feature.completed close-the-loop)";
  readonly capabilities = ["feature.completed", "github-issue-close"];

  private bus?: EventBus;
  private readonly subscriptionIds: string[] = [];
  private readonly closeFn: CloseFn;

  constructor(opts: { closeFn?: CloseFn } = {}) {
    this.closeFn = opts.closeFn ?? ((owner, name, n, o) => defaultCloseIssue(owner, name, n, o));
  }

  install(bus: EventBus): void {
    this.bus = bus;
    this.subscriptionIds.push(
      bus.subscribe("feature.completed", this.name, (msg) => {
        void this._onCompleted(msg);
      }),
    );
    log.info("installed — closing originating GitHub issues on feature.completed");
  }

  uninstall(): void {
    for (const id of this.subscriptionIds) this.bus?.unsubscribe(id);
    this.subscriptionIds.length = 0;
  }

  private async _onCompleted(msg: BusMessage): Promise<void> {
    const p = (msg.payload ?? {}) as FeatureCompletedPayload;
    if (!p.githubIssueNumber || !p.repo) {
      // Not every completed feature originated from a GitHub issue — nothing to close.
      return;
    }
    const [owner, name] = p.repo.split("/");
    if (!owner || !name) {
      log.warn(`feature.completed has malformed repo "${p.repo}" — cannot close #${p.githubIssueNumber}`);
      return;
    }
    const comment = [
      `✅ Resolved by protoMaker${p.prNumber ? ` — shipped in PR #${p.prNumber}` : ""}.`,
      p.featureTitle ? `Feature: ${p.featureTitle}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await this.closeFn(owner, name, p.githubIssueNumber, { comment, reason: "completed" });
      log.info(`closed ${p.repo}#${p.githubIssueNumber} (feature ${p.featureId ?? "?"} shipped)`);
    } catch (err) {
      // Loud, but never breaks the bus / other feature.completed consumers.
      log.warn(`failed to close ${p.repo}#${p.githubIssueNumber}`, { err });
    }
  }
}
