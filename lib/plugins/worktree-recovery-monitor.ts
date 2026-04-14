/**
 * WorktreeRecoveryMonitorPlugin — tracks dirty-worktree recovery events emitted
 * by the automaker server on restart.
 *
 * When the automaker detects uncommitted work in a per-feature worktree on
 * restart it either:
 *   a) commits the WIP to a `recovery/` branch and resumes the feature
 *      (outcome: `auto_recovered`), or
 *   b) finds the worktree unrecoverable (merge conflicts / no branch) and
 *      blocks the feature, escalating to HITL (outcome: `unrecoverable`)
 *
 * This plugin collects those events so downstream analysis can cluster
 * recovery patterns and identify systemic issues.
 *
 * Inbound topics:
 *   worktree.recovered   — published by the automaker after a recovery attempt
 *
 * Outbound topics:
 *   hitl.request.worktree.unrecoverable.{featureId}
 *     — raised for unrecoverable worktrees so a human can inspect the diff
 */

import { randomUUID } from "node:crypto";
import type { Plugin, EventBus, BusMessage, HITLRequest } from "../types.ts";
import type { WorktreeRecoveredPayload } from "../../src/event-bus/payloads.ts";

/** Rolling window for clustering analysis — last N recovery events per project. */
const MAX_EVENTS_PER_PROJECT = 50;

interface RecoveryEvent {
  featureId: string;
  outcome: WorktreeRecoveredPayload["outcome"];
  reason: string;
  recoveryBranch?: string;
  worktreePath?: string;
  recordedAt: string;
}

export class WorktreeRecoveryMonitorPlugin implements Plugin {
  readonly name = "worktree-recovery-monitor";
  readonly description =
    "Tracks dirty-worktree recovery events from the automaker server on restart";
  readonly capabilities = ["worktree.recovery.tracking"];

  /** projectPath → ordered list of recovery events (newest last). */
  private readonly history = new Map<string, RecoveryEvent[]>();

  private subscriptionId: string | null = null;

  install(bus: EventBus): void {
    this.subscriptionId = bus.subscribe(
      "worktree.recovered",
      this.name,
      (msg: BusMessage) => this._handleWorktreeRecovered(msg, bus)
    );
    console.log("[WorktreeRecoveryMonitor] installed — listening on worktree.recovered");
  }

  uninstall(): void {
    if (this.subscriptionId) {
      console.log("[WorktreeRecoveryMonitor] uninstalled");
      this.subscriptionId = null;
    }
  }

  /** Expose history for tests and diagnostic tools. */
  getHistory(projectPath: string): readonly RecoveryEvent[] {
    return this.history.get(projectPath) ?? [];
  }

  private _handleWorktreeRecovered(msg: BusMessage, bus: EventBus): void {
    const payload = msg.payload as WorktreeRecoveredPayload;

    if (!payload?.featureId || !payload?.projectPath || !payload?.outcome) {
      console.warn("[WorktreeRecoveryMonitor] Received malformed worktree.recovered payload");
      return;
    }

    const event: RecoveryEvent = {
      featureId: payload.featureId,
      outcome: payload.outcome,
      reason: payload.reason,
      recoveryBranch: payload.recoveryBranch,
      worktreePath: payload.worktreePath,
      recordedAt: payload.recoveredAt ?? new Date().toISOString(),
    };

    // Append to project history
    const projectHistory = this.history.get(payload.projectPath) ?? [];
    projectHistory.push(event);
    if (projectHistory.length > MAX_EVENTS_PER_PROJECT) {
      projectHistory.shift();
    }
    this.history.set(payload.projectPath, projectHistory);

    if (payload.outcome === "auto_recovered") {
      console.log(
        `[WorktreeRecoveryMonitor] Feature ${payload.featureId} auto-recovered → ${payload.recoveryBranch}`
      );
    } else {
      // unrecoverable — escalate to HITL so a human can inspect the worktree
      console.warn(
        `[WorktreeRecoveryMonitor] Feature ${payload.featureId} worktree is unrecoverable — escalating to HITL`
      );
      this._escalateHITL(payload, bus);
    }
  }

  private _escalateHITL(payload: WorktreeRecoveredPayload, bus: EventBus): void {
    const correlationId = randomUUID();
    const replyTopic = `hitl.response.worktree.unrecoverable.${correlationId}`;
    const topic = `hitl.request.worktree.unrecoverable.${payload.featureId}`;

    const request: HITLRequest = {
      type: "hitl_request",
      correlationId,
      title: `Unrecoverable worktree — feature ${payload.featureId}`,
      summary:
        `The automaker server restarted and found an unrecoverable dirty worktree for ` +
        `feature **${payload.featureId}**.\n\n` +
        `**Reason:** ${payload.reason}\n\n` +
        (payload.worktreePath
          ? `**Worktree path:** \`${payload.worktreePath}\`\n\n`
          : "") +
        `Manual inspection and cleanup is required before this feature can be resumed.`,
      options: ["acknowledge"],
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      replyTopic,
    };

    bus.publish(topic, {
      id: randomUUID(),
      correlationId,
      topic,
      timestamp: Date.now(),
      payload: request,
    });

    console.log(
      `[WorktreeRecoveryMonitor] HITL escalation published for feature ${payload.featureId} (correlationId: ${correlationId})`
    );
  }
}
