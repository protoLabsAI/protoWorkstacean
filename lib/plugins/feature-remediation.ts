/**
 * FeatureRemediationPlugin — the fleet's single auto-remediation loop.
 *
 * Subscribes to `feature.blocked` (raised by protoMaker's automode via the
 * workstacean `/publish` ingress whenever a feature transitions to blocked) and
 * routes it to remediation by `kind`:
 *
 *   - dependency-unsatisfied      → ignore (protoMaker self-heals on staleDeps)
 *   - cost / runtime / quota      → HITL directly (no auto-action can help)
 *   - everything else             → dispatch Roxy `unblock_feature` — she
 *     investigates (CI red / merge conflict / changes-requested / retries) and
 *     takes the smallest unblocking action (rebase / dispatch a fix / re-queue)
 *     or escalates with a crisp ask.
 *
 * Bounded: at most MAX_ATTEMPTS auto-remediations per feature, with a cooldown
 * between them; on exhaustion it escalates ONCE to the operator and goes quiet
 * (bottlenecks-are-growth — a stuck loop becomes a HITL signal, never silent
 * infinite retry). A `feature.unblocked` event clears the tracker so a feature
 * that recovers and later re-blocks gets a fresh budget.
 *
 * This SUBSUMES the old pr-remediator: protoMaker now detects stuck PRs (CI red,
 * conflict, fresh-eyes block) as blocked features and emits one canonical kinded
 * signal, instead of workstacean re-deriving PR-pipeline violations and dispatching
 * ad-hoc fixes. Non-feature PRs (dependabot/renovate) use GitHub-native auto-merge.
 */

import type { Plugin, EventBus, BusMessage } from "../types.ts";
import { getFleetConfig } from "../fleet/fleet-config.ts";
import { logger } from "../log.ts";

const log = logger("feature-remediation");

export interface FeatureBlockedPayload {
  projectSlug?: string;
  projectPath?: string;
  featureId: string;
  featureTitle?: string;
  /** Why it blocked — drives the routing. */
  kind?: string;
  reason?: string;
  prNumber?: number;
  branchName?: string;
  retryCount?: number;
  retryable?: boolean;
  failureCategory?: string;
  detail?: string;
}

/** Kinds protoMaker resolves on its own (dependency gating) — no action here. */
const IGNORE_KINDS = new Set(["dependency_unsatisfied", "external_dependency_unsatisfied"]);
/** Kinds auto-action can't fix — straight to the operator. */
const HITL_KINDS = new Set(["cost_exceeded", "runtime_exceeded", "quota", "rate_limit", "worktree_safety"]);

const MAX_ATTEMPTS = 3;
const COOLDOWN_MS = 5 * 60_000;
/** Drop a feature's tracker after this long with no events (fresh budget on a later re-block). */
const ENTRY_TTL_MS = 60 * 60_000;

interface Tracked {
  attempts: number;
  lastAttemptAt: number;
  lastSeenAt: number;
  escalated: boolean;
}

export class FeatureRemediationPlugin implements Plugin {
  readonly name = "feature-remediation";
  readonly description =
    "Routes feature.blocked → Roxy unblock_feature / HITL, bounded with operator escalation. Subsumes pr-remediator.";
  readonly capabilities = ["feature-remediation", "hitl-emit"];

  private bus?: EventBus;
  private readonly subscriptionIds: string[] = [];
  private readonly tracked = new Map<string, Tracked>();
  private sweepTimer?: ReturnType<typeof setInterval>;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  install(bus: EventBus): void {
    this.bus = bus;
    this.subscriptionIds.push(bus.subscribe("feature.blocked", this.name, (msg) => this._onBlocked(msg)));

    // Terminal or recovery signals — clear the tracker so a later re-block
    // starts with a fresh attempt budget.  `feature.completed` and
    // `feature.failed` are the actual events protoMaker emits today;
    // `feature.unblocked` is kept for when protoMaker adds that emitter.
    const evict = (msg: BusMessage) => {
      const p = msg.payload as FeatureBlockedPayload;
      this.tracked.delete(this._key(p));
    };
    this.subscriptionIds.push(bus.subscribe("feature.unblocked", this.name, evict));
    this.subscriptionIds.push(bus.subscribe("feature.completed", this.name, evict));
    this.subscriptionIds.push(bus.subscribe("feature.failed", this.name, evict));

    this.sweepTimer = setInterval(() => this._sweep(), ENTRY_TTL_MS);
    this.sweepTimer.unref?.();
    log.info("installed — routing feature.blocked");
  }

  uninstall(): void {
    for (const id of this.subscriptionIds) this.bus?.unsubscribe(id);
    this.subscriptionIds.length = 0;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private _key(p: FeatureBlockedPayload): string {
    return `${p.projectSlug ?? p.projectPath ?? "?"}::${p.featureId}`;
  }

  private _onBlocked(msg: BusMessage): void {
    const p = (msg.payload ?? {}) as FeatureBlockedPayload;
    if (!p.featureId) {
      log.warn("feature.blocked without featureId — dropping");
      return;
    }
    const kind = p.kind ?? "unknown";

    if (IGNORE_KINDS.has(kind)) {
      log.info(`${p.featureId} kind=${kind} — protoMaker self-heals; ignoring`);
      return;
    }

    const key = this._key(p);
    const entry = this.tracked.get(key) ?? { attempts: 0, lastAttemptAt: 0, lastSeenAt: 0, escalated: false };
    entry.lastSeenAt = this.now();
    this.tracked.set(key, entry);

    if (HITL_KINDS.has(kind)) {
      this._escalate(p, entry, `blocked (${kind}) — needs an operator decision; auto-remediation won't help`);
      return;
    }

    if (entry.attempts >= MAX_ATTEMPTS) {
      this._escalate(p, entry, `auto-remediation exhausted after ${entry.attempts} attempt(s) (kind=${kind})`);
      return;
    }
    if (entry.lastAttemptAt && this.now() - entry.lastAttemptAt < COOLDOWN_MS) {
      log.info(`${p.featureId} kind=${kind} — within cooldown, skipping`);
      return;
    }

    entry.attempts += 1;
    entry.lastAttemptAt = this.now();
    this.tracked.set(key, entry);
    this._dispatchUnblock(p, msg.correlationId);
  }

  /** Dispatch Roxy's unblock_feature with the blocked-feature context. */
  private _dispatchUnblock(p: FeatureBlockedPayload, correlationId: string): void {
    if (!this.bus) return;
    const project = p.projectSlug ?? p.projectPath ?? "(unknown project)";
    const lines = [
      `Feature ${p.featureId}${p.featureTitle ? ` ("${p.featureTitle}")` : ""} in ${project} is blocked.`,
      `Kind: ${p.kind ?? "unknown"}.${p.reason ? ` Reason: ${p.reason}` : ""}`,
      ...(p.prNumber ? [`PR #${p.prNumber}${p.branchName ? ` (branch ${p.branchName})` : ""}.`] : []),
      `Investigate and take the smallest unblocking action, or escalate with a crisp ask.`,
    ];
    log.info(`→ Roxy unblock_feature: ${p.featureId} (kind=${p.kind}, attempt via dispatch)`);
    this.bus.publish("agent.skill.request", {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: "agent.skill.request",
      timestamp: this.now(),
      payload: {
        skill: "unblock_feature",
        content: lines.join("\n"),
        targets: [getFleetConfig().remediator],
        meta: {
          systemActor: "feature-remediation",
          featureId: p.featureId,
          projectSlug: p.projectSlug,
          kind: p.kind,
          prNumber: p.prNumber,
          sourceCorrelationId: correlationId,
        },
      },
    });
  }

  /** Escalate once to the operator; subsequent triggers stay quiet until cleared. */
  private _escalate(p: FeatureBlockedPayload, entry: Tracked, why: string): void {
    if (!this.bus || entry.escalated) return;
    entry.escalated = true;
    this.tracked.set(this._key(p), entry);
    const project = p.projectSlug ?? p.projectPath ?? "(unknown project)";
    const message = [
      `🚧 Feature stuck — operator attention needed.`,
      `${p.featureId}${p.featureTitle ? ` "${p.featureTitle}"` : ""} in ${project}: ${why}.`,
      ...(p.reason ? [`Reason: ${p.reason}`] : []),
      ...(p.prNumber ? [`PR #${p.prNumber}.`] : []),
    ].join("\n");
    const urgency = HITL_KINDS.has(p.kind ?? "") ? "high" : "medium";
    log.warn(`STUCK → escalating to operator: ${p.featureId} (kind=${p.kind}) — ${why}`);
    this.bus.publish("operator.message.request", {
      id: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      topic: "operator.message.request",
      timestamp: this.now(),
      payload: {
        type: "operator_message_request",
        message,
        urgency,
        topic: `feature-blocked/${project}/${p.featureId}`,
        from: "feature-remediation",
      },
    });
  }

  private _sweep(): void {
    const cutoff = this.now() - ENTRY_TTL_MS;
    for (const [k, e] of this.tracked) if (e.lastSeenAt < cutoff) this.tracked.delete(k);
  }
}
