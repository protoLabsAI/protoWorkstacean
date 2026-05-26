/**
 * QuinnReviewNotifierPlugin — subscribes to `quinn.review.submitted` and
 * fires a Discord alert when Quinn requests changes on a PR. The verdict
 * needs human eyes, and waiting for someone to refresh GitHub before they
 * see it defeats the purpose of having an autonomous QA agent — Discord is
 * where the operator already looks.
 *
 * Inbound:
 *   quinn.review.submitted — { owner, repo, prNumber, event, prUrl, bodyPreview }
 *     fired by pr-inspector's review_* actions
 *
 * Outbound:
 *   message.outbound.discord.alert — picked up by WorldEngineAlertPlugin,
 *     rendered as a severity-colored embed and posted via DISCORD_WEBHOOK_ALERTS
 *
 * Filter policy (intentional):
 *   - REQUEST_CHANGES → fire alert (severity: medium)
 *   - APPROVE / COMMENT → silent. Approves are the common case; emitting on
 *     every one would just be noise. Add a separate APPROVE notifier later
 *     if there's value in seeing "Quinn cleared this" signals — for now,
 *     only the blocking verdicts get the Discord ping.
 *
 * This plugin is a notification surface, not a chokepoint — failure to
 * publish the outbound alert logs a warn but does not propagate (the
 * upstream review POST already succeeded by the time this fires).
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import { REVIEW_TOPICS } from "../event-bus/topics.ts";

interface QuinnReviewSubmittedPayload {
  owner: string;
  repo: string;
  prNumber: number;
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  prUrl?: string;
  bodyPreview?: string;
}

export class QuinnReviewNotifierPlugin implements Plugin {
  readonly name = "quinn-review-notifier";
  readonly description =
    "Routes Quinn's REQUEST_CHANGES verdicts to message.outbound.discord.alert";
  readonly capabilities = ["review-notification"];
  readonly subscribes = [REVIEW_TOPICS.QUINN_REVIEW_SUBMITTED];
  readonly publishes = ["message.outbound.discord.alert"];

  private bus?: EventBus;
  private readonly subscriptionIds: string[] = [];

  install(bus: EventBus): void {
    this.bus = bus;
    const subId = bus.subscribe(
      REVIEW_TOPICS.QUINN_REVIEW_SUBMITTED,
      this.name,
      (msg) => this._handle(msg),
    );
    this.subscriptionIds.push(subId);
    console.log("[quinn-review-notifier] installed — REQUEST_CHANGES verdicts will fire Discord alerts");
  }

  uninstall(): void {
    if (this.bus) {
      for (const id of this.subscriptionIds) this.bus.unsubscribe(id);
    }
    this.subscriptionIds.length = 0;
    this.bus = undefined;
  }

  private _handle(msg: BusMessage): void {
    if (!this.bus) return;
    const payload = (msg.payload ?? {}) as Partial<QuinnReviewSubmittedPayload>;
    if (payload.event !== "REQUEST_CHANGES") return;
    if (!payload.owner || !payload.repo || !payload.prNumber) {
      console.warn(
        `[quinn-review-notifier] dropping malformed REQUEST_CHANGES event — missing owner/repo/prNumber`,
      );
      return;
    }

    const prRef = `${payload.owner}/${payload.repo}#${payload.prNumber}`;
    const prUrl = payload.prUrl ?? `https://github.com/${payload.owner}/${payload.repo}/pull/${payload.prNumber}`;
    const preview = (payload.bodyPreview ?? "").trim();
    const text =
      `[MEDIUM] Quinn requested changes on ${prRef}\n` +
      `→ ${prUrl}` +
      (preview ? `\n\n${preview.slice(0, 400)}${preview.length > 400 ? "…" : ""}` : "");

    const alertMsg: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: msg.correlationId,
      topic: "message.outbound.discord.alert",
      timestamp: Date.now(),
      payload: {
        text,
        actionId: "quinn.review.request_changes",
        goalId: "pr-quality",
        meta: {
          severity: "medium",
          agentId: "quinn",
          extra: {
            owner: payload.owner,
            repo: payload.repo,
            prNumber: payload.prNumber,
            prUrl,
            verdict: payload.event,
          },
        },
      },
    };

    try {
      this.bus.publish("message.outbound.discord.alert", alertMsg);
      console.log(`[quinn-review-notifier] REQUEST_CHANGES on ${prRef} → discord.alert`);
    } catch (err) {
      console.warn(
        `[quinn-review-notifier] failed to publish discord.alert for ${prRef}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
