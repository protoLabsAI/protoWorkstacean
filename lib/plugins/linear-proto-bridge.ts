/**
 * LinearProtoBridge — dispatches Linear issues tagged with the proto-task
 * label to the in-process `proto` agent (#516 deliverable #3). Pure bus
 * contract; no direct dependency on the Linear plugin or the proto agent
 * runtime.
 *
 * Inbound:
 *   message.inbound.linear.issue.created (published by LinearPlugin)
 *
 * Outbound:
 *   agent.skill.request — skill: code.execute, targets: [proto].
 *   reply.topic: linear.reply.{linearIssueId} so proto's final result
 *   becomes a Linear comment automatically via LinearPlugin's outbound
 *   subscriber. No bridge-side state, no close-the-loop tracking —
 *   `code.execute` is one-shot: dispatch, run to completion, reply.
 *
 * Label gate:
 *   Default trigger label is `proto-task`. Override via env
 *   `LINEAR_PROTO_BRIDGE_LABEL` if the team prefers a different convention.
 *   Issues without the label are dropped at this bridge (RouterPlugin
 *   still handles the chat path via workspace/channels.yaml independently).
 *
 * Why a separate bridge plugin rather than a channels.yaml entry:
 *   channels.yaml maps (platform, channelId) → agent. The Linear platform
 *   has team-key channels but no per-label gate. A label-triggered dispatch
 *   needs to inspect the issue payload — that's bridge logic, not router
 *   logic. Same label-gated-bridge pattern (#481).
 */

import type { EventBus, BusMessage, Plugin } from "../types.ts";

const DEFAULT_TRIGGER_LABEL = "proto-task";

interface LinearIssuePayload {
  issueId: string;
  identifier?: string;
  title: string;
  description?: string;
  content?: string;
  priority?: string;
  teamKey?: string;
  projectName?: string;
  labels?: string[];
  url?: string;
  creatorName?: string;
}

export class LinearProtoBridgePlugin implements Plugin {
  readonly name = "linear-proto-bridge";
  readonly description =
    "Linear issue → proto code.execute bridge (label-gated; default label = proto-task)";
  readonly capabilities = ["linear-proto-bridge"];

  private readonly subscriptionIds: string[] = [];
  private readonly triggerLabel: string;

  constructor() {
    const envLabel = (process.env["LINEAR_PROTO_BRIDGE_LABEL"] ?? "").trim();
    this.triggerLabel = envLabel || DEFAULT_TRIGGER_LABEL;
  }

  install(bus: EventBus): void {
    const subId = bus.subscribe(
      "message.inbound.linear.issue.created",
      this.name,
      (msg: BusMessage) => this._handleIssueCreated(bus, msg),
    );
    this.subscriptionIds.push(subId);

    console.log(
      `[linear-proto-bridge] installed — gating on label "${this.triggerLabel}"`,
    );
  }

  uninstall(): void {
    // Bus subscriptions are owned by the bus; nothing to actively cancel
    // here beyond clearing local state.
    this.subscriptionIds.length = 0;
  }

  private _handleIssueCreated(bus: EventBus, msg: BusMessage): void {
    const payload = (msg.payload ?? {}) as LinearIssuePayload;
    if (!payload.issueId || !payload.title) return;

    const labels = payload.labels ?? [];
    if (!labels.includes(this.triggerLabel)) {
      // Quiet drop — RouterPlugin's chat path may legitimately handle this
      // same event for its own purposes. Logging every non-matching
      // event would spam the dev channel.
      return;
    }

    const replyTopic = `linear.reply.${payload.issueId}`;
    const description = payload.description ?? "";
    const content =
      `Execute this scoped coding/research task and reply with the result.\n\n` +
      `Title: ${payload.title}\n\n` +
      `Description:\n${description || "(none provided)"}\n\n` +
      `Source: Linear issue ${payload.identifier ?? payload.issueId}` +
      (payload.url ? ` (${payload.url})` : "") +
      (payload.priority && payload.priority !== "none" ? `\nPriority: ${payload.priority}` : "") +
      (payload.creatorName ? `\nFiled by: ${payload.creatorName}` : "");

    const correlationId = `linear-proto-${payload.issueId}`;
    bus.publish("agent.skill.request", {
      id: crypto.randomUUID(),
      correlationId,
      topic: "agent.skill.request",
      timestamp: Date.now(),
      payload: {
        skill: "code.execute",
        content,
        targets: ["proto"],
        meta: {
          // Preserve enough Linear context for downstream consumers
          // (audit, future close-the-loop variants) to reconstruct the
          // source without round-tripping back through the Linear API.
          sourceLinearIssueId: payload.issueId,
          sourceLinearIdentifier: payload.identifier,
          sourceLinearTeamKey: payload.teamKey,
          sourceLinearUrl: payload.url,
          sourceLinearPriority: payload.priority,
          triggerLabel: this.triggerLabel,
          via: "linear-proto-bridge",
        },
      },
      reply: {
        topic: replyTopic,
        // Linear comment bodies render markdown.
        format: "markdown",
      },
      source: { interface: "linear" as const },
    });

    console.log(
      `[linear-proto-bridge] ${payload.identifier ?? payload.issueId} → code.execute@proto ` +
        `(label="${this.triggerLabel}", reply → ${replyTopic})`,
    );
  }
}
