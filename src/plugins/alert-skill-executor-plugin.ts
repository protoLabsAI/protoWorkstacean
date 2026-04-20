/**
 * AlertSkillExecutorPlugin — registers FunctionExecutors for the GOAP-wired
 * `alert.*` skills that previously had no handler.
 *
 * Six tier_0 fire-and-forget actions in `workspace/actions.yaml` dispatch
 * skills with the same id as the action (no `meta.skillHint`, no
 * `meta.agentId`). Without a registered executor, SkillDispatcherPlugin
 * logged "No executor found … dropping" on every planning cycle and the
 * GOAP loop never produced any visible side-effect.
 *
 * Each executor here translates the dispatch into a structured Discord
 * alert published on `message.outbound.discord.alert` — the same topic
 * `WorldEngineAlertPlugin` already routes to the operator-facing webhook.
 *
 * This is a registrar plugin: it does not subscribe to any topic at runtime.
 * Install order matters — must run AFTER ExecutorRegistry construction and
 * BEFORE SkillDispatcherPlugin so registrations are resolvable on first
 * dispatch.
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import type { SkillRequest, SkillResult } from "../executor/types.ts";
import { FunctionExecutor } from "../executor/executors/function-executor.ts";

/**
 * Every `alert.*` skill in workspace/actions.yaml that has no other handler.
 * Each is a tier_0 fire-and-forget action whose dispatched skill name equals
 * the action id (no skillHint, no agentId routing).
 *
 * The six explicitly tracked by issue #426 are at the top — the rest share
 * the same structural pattern (precondition violated → broadcast a Discord
 * alert) and were silently dropping for the same reason. Wiring them all
 * here closes the systemic gap rather than just the symptoms.
 *
 * Severity is the operator-facing escalation tier surfaced by
 * WorldEngineAlertPlugin's embed colour and Discord routing.
 */
export const ALERT_SKILLS: ReadonlyArray<{
  skill: string;
  severity: "low" | "medium" | "high";
  headline: string;
}> = [
  // ── Issue #426 — explicitly listed ──────────────────────────────────────
  { skill: "alert.branch_unprotected",        severity: "high",   headline: "Repo missing main-branch ruleset" },
  { skill: "alert.ci_main_red",               severity: "high",   headline: "Latest push to main is red" },
  { skill: "alert.issues_bugs",               severity: "medium", headline: "Open bug issues need triage" },
  { skill: "alert.security_incident",         severity: "high",   headline: "Open security incident" },
  { skill: "alert.branch_drift",              severity: "medium", headline: "Branch drift exceeds threshold" },
  { skill: "alert.branch_bypass_actors",      severity: "high",   headline: "Bypass actors present on main ruleset" },
  // ── Same structural gap — all bare `alert.*` actions ─────────────────────
  { skill: "alert.efficiency_low",            severity: "medium", headline: "Flow efficiency below threshold" },
  { skill: "alert.discord_disconnected",      severity: "high",   headline: "Discord bot disconnected" },
  { skill: "alert.no_agents",                 severity: "high",   headline: "No agents registered" },
  { skill: "alert.ci_failures",               severity: "medium", headline: "CI failure rate elevated" },
  { skill: "alert.pr_stale",                  severity: "low",    headline: "Stale PRs accumulating" },
  { skill: "alert.protomaker_board_blocked",  severity: "medium", headline: "protoMaker board has excessive blocked features" },
  { skill: "alert.protomaker_backlog_piling", severity: "low",    headline: "protoMaker backlog growing" },
  { skill: "alert.plane_urgent_stale",        severity: "high",   headline: "Excessive urgent Plane issues" },
  { skill: "alert.plane_stale_backlog",       severity: "medium", headline: "Plane issues >14 days old" },
  { skill: "alert.plane_unassigned_piling",   severity: "medium", headline: "Unassigned Plane issues piling up" },
  { skill: "alert.memory_down",               severity: "high",   headline: "Graphiti memory healthcheck failed" },
  { skill: "alert.memory_search_broken",      severity: "high",   headline: "Graphiti search probe failed" },
  { skill: "alert.fleet_agent_stuck",         severity: "high",   headline: "Agent failure rate >50% over 1h" },
  { skill: "alert.hitl_routing_broken",       severity: "high",   headline: "HITL requests not reaching renderer" },
  { skill: "alert.fleet_cost_over_budget",    severity: "medium", headline: "Fleet LLM spend exceeds daily budget" },
  { skill: "alert.fleet_skill_orphaned",      severity: "medium", headline: "Active skill with no recent successes" },
  { skill: "alert.issues_critical",           severity: "high",   headline: "Critical GitHub issues open" },
  { skill: "alert.issues_total_high",         severity: "low",    headline: "Total open issues exceed threshold" },
];

export class AlertSkillExecutorPlugin implements Plugin {
  readonly name = "alert-skill-executor";
  readonly description = "Registers Discord-alert FunctionExecutors for the GOAP `alert.*` skills";
  readonly capabilities = ["alert-dispatch", "executor-registrar"];

  private bus?: EventBus;

  constructor(private readonly registry: ExecutorRegistry) {}

  install(bus: EventBus): void {
    this.bus = bus;
    for (const entry of ALERT_SKILLS) {
      const executor = new FunctionExecutor(async (req) => this._execute(req, entry));
      this.registry.register(entry.skill, executor, { priority: 5 });
    }
    console.log(
      `[alert-skill-executor] Registered ${ALERT_SKILLS.length} alert executor(s): ${ALERT_SKILLS.map(a => a.skill).join(", ")}`,
    );
  }

  uninstall(): void {
    this.bus = undefined;
  }

  /**
   * Translate a GOAP skill dispatch into a Discord-alert bus event.
   *
   * The published payload matches the shape `WorldEngineAlertPlugin`
   * already consumes — actionId, goalId, meta.{severity, agentId, extra}.
   * Returning a non-error SkillResult lets ActionDispatcherPlugin record
   * a successful outcome instead of timing out.
   */
  private async _execute(
    req: SkillRequest,
    entry: { skill: string; severity: "low" | "medium" | "high"; headline: string },
  ): Promise<SkillResult> {
    if (!this.bus) {
      return {
        text: "alert-skill-executor not installed",
        isError: true,
        correlationId: req.correlationId,
      };
    }

    const meta = (req.payload?.meta ?? {}) as Record<string, unknown>;
    const actionId = typeof meta.actionId === "string" ? meta.actionId : entry.skill;
    const goalId = typeof meta.goalId === "string" ? meta.goalId
      : typeof req.payload?.goalId === "string" ? req.payload.goalId
      : "unknown";

    const text = `[${entry.severity.toUpperCase()}] ${entry.headline} — goal ${goalId} violated`;

    const alertMsg: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: req.correlationId,
      topic: "message.outbound.discord.alert",
      timestamp: Date.now(),
      payload: {
        text,
        actionId,
        goalId,
        meta: {
          severity: entry.severity,
          agentId: "goap",
          extra: { skill: entry.skill, content: req.content },
        },
      },
    };
    this.bus.publish("message.outbound.discord.alert", alertMsg);

    return {
      text,
      isError: false,
      correlationId: req.correlationId,
    };
  }
}
