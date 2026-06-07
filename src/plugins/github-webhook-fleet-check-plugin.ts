/**
 * GithubWebhookFleetCheckPlugin — detects repos with 0 inbound GitHub events.
 *
 * Signature of the silent break: a repo delivers HTTP 200 to the gateway
 * (hooks.proto-labs.ai) but produces 0 inbound events at WS. This plugin
 * catches that class of break by:
 *
 *   1. Subscribing to `message.inbound.github.#` — every GitHub event that
 *      reaches the bus (proves the gateway→WS path is alive for that repo)
 *   2. Comparing against the project registry's known repos (getGithubCoords)
 *   3. Flagging any registry repo with 0 events in the last CHECK_WINDOW_MS
 *   4. Publishing `operator.message.request` when violations are found
 *
 * The fleet_alerts ceremony dispatches `check_github_webhook_routes` every
 * minute. Per-repo cooldown prevents DM flood.
 *
 * Subscribes to: message.inbound.github.#
 * Registers:     check_github_webhook_routes (FunctionExecutor)
 * Publishes to:  operator.message.request
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import type { SkillRequest, SkillResult } from "../executor/types.ts";
import type { ProjectRegistry } from "./project-registry.js";
import { FunctionExecutor } from "../executor/executors/function-executor.ts";
import { logger } from "../../lib/log.ts";

const log = logger("github-webhook-fleet-check");

/** Repos with 0 inbound events in this window are flagged (env: WORKSTACEAN_GITHUB_WEBHOOK_CHECK_WINDOW_MS). Default 30 min. */
const CHECK_WINDOW_MS_DEFAULT = 30 * 60_000;

/** Minimum interval between alerts for the same repo (env: WORKSTACEAN_GITHUB_WEBHOOK_ALERT_COOLDOWN_MS). Default 60 min. */
const ALERT_COOLDOWN_MS_DEFAULT = 60 * 60_000;

interface RepoEventRecord {
  /** Last known inbound event timestamp for this repo. */
  lastEventAt: number;
  /** Total inbound event count (for diagnostic context). */
  totalEvents: number;
}

export class GithubWebhookFleetCheckPlugin implements Plugin {
  readonly name = "github-webhook-fleet-check";
  readonly description =
    "Detects repos with 0 inbound GitHub events — catches gateway routing silent breaks";
  readonly capabilities = ["github-webhook-fleet-check", "executor-registrar"];

  private bus?: EventBus;
  private readonly subscriptionIds: string[] = [];
  /** Per-repo event tracking. Key: "owner/repo" (lowercase). */
  private readonly repoEvents = new Map<string, RepoEventRecord>();
  private readonly lastAlertedAt = new Map<string, number>();

  private readonly checkWindowMs: number;
  private readonly alertCooldownMs: number;

  constructor(
    private readonly registry: ExecutorRegistry,
    private readonly projectRegistry: ProjectRegistry,
  ) {
    this.checkWindowMs =
      Number(process.env["WORKSTACEAN_GITHUB_WEBHOOK_CHECK_WINDOW_MS"]) || CHECK_WINDOW_MS_DEFAULT;
    this.alertCooldownMs =
      Number(process.env["WORKSTACEAN_GITHUB_WEBHOOK_ALERT_COOLDOWN_MS"]) || ALERT_COOLDOWN_MS_DEFAULT;
  }

  install(bus: EventBus): void {
    this.bus = bus;

    // Track every inbound GitHub event by repo.
    // Topic pattern: message.inbound.github.{owner}.{repo}.{event}.{number}
    this.subscriptionIds.push(
      bus.subscribe("message.inbound.github.#", this.name, (msg: BusMessage) => {
        this._onInboundEvent(msg);
      }),
    );

    const executor = new FunctionExecutor(async (req: SkillRequest) => this._execute(req));
    this.registry.register("check_github_webhook_routes", executor, { priority: 5 });

    log.info(
      `Installed — checkWindow=${Math.round(this.checkWindowMs / 60_000)}min, ` +
        `alertCooldown=${Math.round(this.alertCooldownMs / 60_000)}min`,
    );
  }

  uninstall(): void {
    if (this.bus) {
      for (const id of this.subscriptionIds) this.bus.unsubscribe(id);
    }
    this.subscriptionIds.length = 0;
    this.bus = undefined;
    this.lastAlertedAt.clear();
  }

  /**
   * Public for testing — returns the current state of tracked repos.
   */
  getRepoEvents(): Map<string, RepoEventRecord> {
    return this.repoEvents;
  }

  private _onInboundEvent(msg: BusMessage): void {
    // Extract owner/repo from topic: message.inbound.github.{owner}.{repo}.{event}...
    const parts = msg.topic.split(".");
    // message.inbound.github.{owner}.{repo}... → parts[3]=owner, parts[4]=repo
    if (parts.length < 5) return;
    const owner = parts[3]!;
    const repo = parts[4]!;
    const key = `${owner}/${repo}`.toLowerCase();

    const record = this.repoEvents.get(key) ?? { lastEventAt: 0, totalEvents: 0 };
    record.lastEventAt = msg.timestamp;
    record.totalEvents += 1;
    this.repoEvents.set(key, record);
  }

  private async _execute(req: SkillRequest): Promise<SkillResult> {
    if (!this.bus) {
      return { text: "github-webhook-fleet-check not installed", isError: true, correlationId: req.correlationId };
    }

    const knownRepos = this.projectRegistry.getGithubCoords();
    if (knownRepos.length === 0) {
      return {
        text: "No GitHub repos in project registry — skipping check",
        isError: false,
        correlationId: req.correlationId,
      };
    }

    const now = Date.now();
    const violations = this._check(knownRepos, now);

    if (violations.length === 0) {
      return {
        text: `All ${knownRepos.length} repo(s) have recent inbound GitHub events`,
        isError: false,
        correlationId: req.correlationId,
      };
    }

    const fired: string[] = [];
    const suppressed: string[] = [];

    for (const v of violations) {
      const last = this.lastAlertedAt.get(v.repo);
      if (last !== undefined && now - last < this.alertCooldownMs) {
        suppressed.push(v.repo);
        continue;
      }
      this.lastAlertedAt.set(v.repo, now);
      this._escalate(req.correlationId, v);
      fired.push(v.repo);
    }

    const detail = fired.length > 0
      ? `${fired.length} new alert(s) [${fired.join(", ")}]`
      : "all suppressed";
    return {
      text: `${violations.length} repo(s) with 0 inbound events — ${detail}${suppressed.length > 0 ? `, ${suppressed.length} cooldown-suppressed [${suppressed.join(", ")}]` : ""}`,
      isError: false,
      correlationId: req.correlationId,
    };
  }

  /**
   * Pure function — returns repos that have had 0 inbound events in the check window.
   */
  private _check(knownRepos: string[], now: number): Array<{ repo: string; lastEventAt: number | null; totalEvents: number }> {
    const violations: Array<{ repo: string; lastEventAt: number | null; totalEvents: number }> = [];

    for (const repo of knownRepos) {
      const key = repo.toLowerCase();
      const record = this.repoEvents.get(key);

      if (!record || (now - record.lastEventAt) > this.checkWindowMs) {
        violations.push({
          repo,
          lastEventAt: record?.lastEventAt ?? null,
          totalEvents: record?.totalEvents ?? 0,
        });
      }
    }

    return violations;
  }

  private _escalate(parentCorrelationId: string, violation: { repo: string; lastEventAt: number | null; totalEvents: number }): void {
    if (!this.bus) return;

    const lines: string[] = [
      `GitHub webhook route silent: \`${violation.repo}\` has had 0 inbound events in the last ${Math.round(this.checkWindowMs / 60_000)}min.`,
      "",
      `**Signature:** gateway returns 200 but events never reach WS.`,
      `**Total events seen:** ${violation.totalEvents}`,
      violation.lastEventAt
        ? `**Last event:** ${new Date(violation.lastEventAt).toISOString()}`
        : `**Last event:** never`,
      "",
      `**Fix:** check hooks.proto-labs.ai gateway routing for \`${violation.repo}\`. ` +
        `Confirm by watching for \`message.inbound.github.*\` after a PR event.`,
    ];

    const correlationId = `github-webhook-check-${violation.repo}-${Date.now()}`;
    this.bus.publish("operator.message.request", {
      id: crypto.randomUUID(),
      correlationId,
      topic: "operator.message.request",
      timestamp: Date.now(),
      payload: {
        type: "operator_message_request",
        correlationId,
        message: lines.join("\n"),
        urgency: "high",
        topic: `github-webhook-silent/${violation.repo}`,
        from: "github-webhook-fleet-check",
        parentCorrelationId,
      },
    });

    log.warn(
      `SILENT ROUTE → escalating: ${violation.repo} (0 events in ${Math.round(this.checkWindowMs / 60_000)}min)`,
    );
  }
}
