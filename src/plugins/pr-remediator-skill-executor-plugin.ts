/**
 * PrRemediatorSkillExecutorPlugin — registers FunctionExecutors for the five
 * GOAP-wired `action.pr_*` and `action.dispatch_backmerge` skills whose
 * handlers already live in `lib/plugins/pr-remediator.ts`.
 *
 * Without these registrations the SkillDispatcherPlugin logs
 * "No executor found for skill action.pr_..." and drops the dispatch on
 * every planning cycle. After PR #427 added the startup validator the same
 * gap also raises a HIGH `platform.skills_unwired` alert each tick.
 *
 * The pr-remediator plugin already subscribes to its own internal trigger
 * topics (`pr.remediate.*`, `pr.backmerge.dispatch`) — see
 * `PrRemediatorPlugin.install()`. Each executor in this file translates a
 * GOAP skill dispatch into a publish on the matching trigger topic and
 * returns a successful SkillResult immediately (fire-and-forget semantics
 * declared in actions.yaml).
 *
 * Routing through the bus rather than calling the plugin directly keeps the
 * "bus is the contract" invariant — the executor never holds a reference
 * to PrRemediatorPlugin, only to the EventBus.
 *
 * Install order matters: AFTER ExecutorRegistry construction and BEFORE
 * SkillDispatcherPlugin so registrations resolve on first dispatch.
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import type { SkillRequest, SkillResult } from "../executor/types.ts";
import { FunctionExecutor } from "../executor/executors/function-executor.ts";

/**
 * Maps each GOAP action id to the bus topic that PrRemediatorPlugin already
 * subscribes to. Adding a new action is one line here plus the corresponding
 * `bus.subscribe()` in pr-remediator.ts.
 */
export const PR_REMEDIATOR_SKILL_TOPICS: ReadonlyArray<{
  skill: string;
  topic: string;
}> = [
  { skill: "action.pr_update_branch",     topic: "pr.remediate.update_branch" },
  { skill: "action.pr_merge_ready",       topic: "pr.remediate.merge_ready" },
  { skill: "action.pr_fix_ci",            topic: "pr.remediate.fix_ci" },
  { skill: "action.pr_address_feedback",  topic: "pr.remediate.address_feedback" },
  { skill: "action.dispatch_backmerge",   topic: "pr.backmerge.dispatch" },
];

export class PrRemediatorSkillExecutorPlugin implements Plugin {
  readonly name = "pr-remediator-skill-executor";
  readonly description = "Registers FunctionExecutors that route GOAP `action.pr_*` skills to PrRemediatorPlugin's bus topics";
  readonly capabilities = ["pr-remediator-dispatch", "executor-registrar"];

  private bus?: EventBus;

  constructor(private readonly registry: ExecutorRegistry) {}

  install(bus: EventBus): void {
    this.bus = bus;
    for (const entry of PR_REMEDIATOR_SKILL_TOPICS) {
      const executor = new FunctionExecutor(async (req) => this._execute(req, entry));
      this.registry.register(entry.skill, executor, { priority: 5 });
    }
    console.log(
      `[pr-remediator-skill-executor] Registered ${PR_REMEDIATOR_SKILL_TOPICS.length} executor(s): ${PR_REMEDIATOR_SKILL_TOPICS.map(e => e.skill).join(", ")}`,
    );
  }

  uninstall(): void {
    this.bus = undefined;
  }

  /**
   * Translate a GOAP skill dispatch into the pr-remediator trigger event.
   *
   * The published payload mirrors the meta forwarded by ActionDispatcherPlugin
   * (actionId, goalId, hitlPolicy, systemActor) so downstream handlers can
   * honour action-level policy without a second lookup.
   *
   * Fire-and-forget: returns a successful SkillResult immediately. The
   * pr-remediator handler runs asynchronously on the bus subscription.
   * Failures inside the handler surface via its own logging and HITL
   * escalation paths — see `_emitStuckHitlEscalation`.
   */
  private async _execute(
    req: SkillRequest,
    entry: { skill: string; topic: string },
  ): Promise<SkillResult> {
    if (!this.bus) {
      // Fail fast — surface, don't swallow.
      return {
        text: "pr-remediator-skill-executor not installed",
        isError: true,
        correlationId: req.correlationId,
      };
    }

    const meta = (req.payload?.meta ?? {}) as Record<string, unknown>;
    const triggerMsg: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: req.correlationId,
      ...(req.parentId ? { parentId: req.parentId } : {}),
      topic: entry.topic,
      timestamp: Date.now(),
      payload: {
        actionId: typeof meta.actionId === "string" ? meta.actionId : entry.skill,
        goalId: typeof meta.goalId === "string" ? meta.goalId
          : typeof req.payload?.goalId === "string" ? req.payload.goalId
          : undefined,
        meta,
      },
    };
    this.bus.publish(entry.topic, triggerMsg);

    return {
      text: `dispatched ${entry.skill} → ${entry.topic}`,
      isError: false,
      correlationId: req.correlationId,
    };
  }
}
