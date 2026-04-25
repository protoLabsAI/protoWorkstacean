/**
 * LinearProtoMakerBridge — translates Linear issue events into protoMaker
 * board feature creations, with no direct dependency on either the Linear
 * plugin or the protoMaker integration. Pure bus contract.
 *
 * Inbound:
 *   message.inbound.linear.issue.created (published by LinearPlugin)
 *
 * Outbound:
 *   agent.skill.request — skill: manage_feature, targets: [protomaker],
 *   reply.topic: linear.reply.{linearIssueId} so protoMaker's response
 *   becomes a Linear comment automatically via LinearPlugin's outbound
 *   subscriber. Filing close-the-loop ships in the same dispatch — no
 *   bridge-side state needed.
 *
 * Configuration:
 *   workspace/linear-board-mappings.yaml declares which Linear team feeds
 *   into which protoMaker project, and which label gates filing:
 *
 *     mappings:
 *       - linearTeamKey: "ENG"
 *         protoMakerProjectSlug: "engineering"
 *         triggerLabel: "board"
 *       - linearTeamKey: "DESIGN"
 *         protoMakerProjectSlug: "design-system"
 *         triggerLabel: "board"
 *
 *   Issues without the trigger label are dropped here — RouterPlugin still
 *   handles the chat path via workspace/channels.yaml independently.
 *
 * Done close-the-loop (deferred):
 *   Posting a "feature completed" comment when the protoMaker board moves
 *   the feature to done is not yet wired — there's no bus event today for
 *   board-state lifecycle. When protoMaker emits a board feature
 *   completed event, add a single subscriber here that maps featureId →
 *   linearIssueId (which we'd need to start tracking) and publishes
 *   linear.reply.{linearIssueId}. Tracked separately.
 */

import { existsSync, readFileSync, watchFile } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { EventBus, BusMessage, Plugin } from "../types.ts";

const LinearBoardMappingSchema = z.object({
  linearTeamKey: z.string().min(1),
  protoMakerProjectSlug: z.string().min(1),
  /** Label that gates filing. Issue must carry this label to fire. */
  triggerLabel: z.string().min(1),
});

const LinearBoardMappingsFileSchema = z.object({
  mappings: z.array(LinearBoardMappingSchema).optional(),
});

type LinearBoardMapping = z.infer<typeof LinearBoardMappingSchema>;

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

export class LinearProtoMakerBridgePlugin implements Plugin {
  readonly name = "linear-protomaker-bridge";
  readonly description =
    "Linear issue → protoMaker board feature bridge (label-triggered, auto-file)";
  readonly capabilities = ["linear-protomaker-bridge"];

  private readonly workspaceDir: string;
  private readonly subscriptionIds: string[] = [];
  private mappings: LinearBoardMapping[] = [];

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  install(bus: EventBus): void {
    this._loadMappings();
    const mappingsPath = join(this.workspaceDir, "linear-board-mappings.yaml");
    if (existsSync(mappingsPath)) {
      // Hot-reload — operator can adjust trigger labels / project routes
      // without a process restart.
      watchFile(mappingsPath, { interval: 5_000 }, () => this._loadMappings());
    }

    const subId = bus.subscribe(
      "message.inbound.linear.issue.created",
      this.name,
      (msg: BusMessage) => this._handleIssueCreated(bus, msg),
    );
    this.subscriptionIds.push(subId);

    console.log(
      `[linear-protomaker-bridge] installed with ${this.mappings.length} mapping(s)`,
    );
  }

  uninstall(): void {
    // Bus subscriptions are owned by the bus; nothing to actively cancel
    // here beyond clearing local state.
    this.subscriptionIds.length = 0;
  }

  private _loadMappings(): void {
    const path = join(this.workspaceDir, "linear-board-mappings.yaml");
    if (!existsSync(path)) {
      this.mappings = [];
      return;
    }
    try {
      const raw = parseYaml(readFileSync(path, "utf8"));
      const fileParsed = LinearBoardMappingsFileSchema.safeParse(raw);
      if (!fileParsed.success) {
        const issues = fileParsed.error.issues
          .map(i => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        console.error(`[linear-protomaker-bridge] mappings file failed schema — ${issues}. Keeping prior mappings.`);
        return;
      }
      // Per-entry validation already happened via the array schema above —
      // any malformed entry would have failed the safeParse, so we'd never
      // see partial mappings. This means an operator typo in one entry now
      // rejects the whole file rather than silently filtering it. That's
      // intentional fail-loud for config — clearer signal than a partial
      // load + warning.
      const next = fileParsed.data.mappings ?? [];
      this.mappings = next;
      console.log(
        `[linear-protomaker-bridge] reloaded ${next.length} mapping(s) from ${path}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[linear-protomaker-bridge] failed to parse ${path}: ${msg}. Keeping prior mappings.`);
    }
  }

  private _handleIssueCreated(bus: EventBus, msg: BusMessage): void {
    const payload = (msg.payload ?? {}) as LinearIssuePayload;
    if (!payload.issueId || !payload.teamKey || !payload.title) return;

    const mapping = this.mappings.find(m => m.linearTeamKey === payload.teamKey);
    if (!mapping) return;

    const labels = payload.labels ?? [];
    if (!labels.includes(mapping.triggerLabel)) {
      console.log(
        `[linear-protomaker-bridge] ${payload.identifier ?? payload.issueId} skipped — no '${mapping.triggerLabel}' label (has: ${labels.join(", ") || "none"})`,
      );
      return;
    }

    // Route protoMaker's response through Linear's outbound subscriber so
    // the operator sees the filing confirmation as a Linear comment with
    // zero bridge-side state.
    const replyTopic = `linear.reply.${payload.issueId}`;

    const description = payload.description ?? "";
    const content =
      `Create a feature on the protoMaker board for project '${mapping.protoMakerProjectSlug}'.\n\n` +
      `Title: ${payload.title}\n\n` +
      `Description:\n${description || "(none provided)"}\n\n` +
      `Source: Linear issue ${payload.identifier ?? payload.issueId}` +
      (payload.url ? ` (${payload.url})` : "") +
      (payload.priority && payload.priority !== "none" ? `\nPriority: ${payload.priority}` : "") +
      (payload.creatorName ? `\nFiled by: ${payload.creatorName}` : "");

    const correlationId = `linear-bridge-${payload.issueId}`;
    bus.publish("agent.skill.request", {
      id: crypto.randomUUID(),
      correlationId,
      topic: "agent.skill.request",
      timestamp: Date.now(),
      payload: {
        skill: "manage_feature",
        content,
        targets: ["protomaker"],
        meta: {
          // Preserve enough Linear context for protoMaker handlers (or
          // future audit) to reconstruct the source without going through
          // the bus archive.
          sourceLinearIssueId: payload.issueId,
          sourceLinearIdentifier: payload.identifier,
          sourceLinearTeamKey: payload.teamKey,
          sourceLinearUrl: payload.url,
          sourceLinearPriority: payload.priority,
          protoMakerProjectSlug: mapping.protoMakerProjectSlug,
          via: "linear-protomaker-bridge",
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
      `[linear-protomaker-bridge] ${payload.identifier ?? payload.issueId} → manage_feature for project '${mapping.protoMakerProjectSlug}' (reply → ${replyTopic})`,
    );
  }
}
