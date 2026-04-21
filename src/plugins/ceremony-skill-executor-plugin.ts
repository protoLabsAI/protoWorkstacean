/**
 * CeremonySkillExecutorPlugin — registers FunctionExecutors for the GOAP-wired
 * `ceremony.*` actions that previously had no skill-side handler.
 *
 * Background (issue #430): a small set of tier_0 fire-and-forget actions in
 * `workspace/actions.yaml` exist purely to nudge an existing ceremony — they
 * have no skillHint, no agentId, and their action id is the skill name the
 * dispatcher tries to resolve. CeremonyPlugin already accepts external
 * triggers on `ceremony.<id>.execute`, but nothing was bridging the GOAP
 * action id to that topic, so SkillDispatcherPlugin dropped every dispatch
 * with `No executor found for skill "ceremony.X"`. After PR #427 those drops
 * also fire HIGH `platform.skills_unwired` alerts every planning cycle.
 *
 * Each registered executor here translates the dispatch into a single
 * `ceremony.<id>.execute` publish and returns a successful SkillResult so
 * ActionDispatcherPlugin records a clean outcome.
 *
 * Registration mapping is explicit (not derived) — action ids and ceremony
 * ids deliberately differ in punctuation (underscores vs. dashes), and
 * pretending the mapping is mechanical hides the contract.
 *
 * Install order: must run AFTER ExecutorRegistry construction and BEFORE
 * SkillDispatcherPlugin so registrations are resolvable on first dispatch.
 * (Same constraint as `alert-skill-executor-plugin`.)
 */

import type { Plugin, EventBus, BusMessage } from "../../lib/types.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import type { SkillRequest, SkillResult } from "../executor/types.ts";
import { FunctionExecutor } from "../executor/executors/function-executor.ts";

/**
 * Action id (== skill name on agent.skill.request) → ceremony id to trigger.
 *
 * The mapping is intentionally explicit: action ids in actions.yaml use
 * snake_case and may carry suffixes describing the trigger condition
 * (e.g. `_discord` for the Discord-disconnect path), while ceremony ids in
 * `workspace/ceremonies/*.yaml` use kebab-case file-based ids.
 */
export const CEREMONY_SKILLS: ReadonlyArray<{
  skill: string;
  ceremonyId: string;
  description: string;
}> = [
  {
    skill: "ceremony.security_triage",
    ceremonyId: "security-triage",
    description: "Open security incidents detected — trigger security-triage ceremony",
  },
  {
    skill: "ceremony.service_health_discord",
    ceremonyId: "service-health",
    description: "Discord bot disconnected — trigger service-health ceremony",
  },
];

export class CeremonySkillExecutorPlugin implements Plugin {
  readonly name = "ceremony-skill-executor";
  readonly description = "Registers FunctionExecutors that bridge GOAP `ceremony.*` actions to ceremony.<id>.execute triggers";
  readonly capabilities = ["ceremony-trigger", "executor-registrar"];

  private bus?: EventBus;

  constructor(private readonly registry: ExecutorRegistry) {}

  install(bus: EventBus): void {
    this.bus = bus;
    for (const entry of CEREMONY_SKILLS) {
      const executor = new FunctionExecutor(async (req) => this._execute(req, entry));
      this.registry.register(entry.skill, executor, { priority: 5 });
    }
    console.log(
      `[ceremony-skill-executor] Registered ${CEREMONY_SKILLS.length} ceremony executor(s): ${CEREMONY_SKILLS.map(c => c.skill).join(", ")}`,
    );
  }

  uninstall(): void {
    this.bus = undefined;
  }

  /**
   * Translate a GOAP skill dispatch into a `ceremony.<id>.execute` bus event.
   *
   * The published payload deliberately carries `type: "external.trigger"`
   * (anything other than `"ceremony.execute"`) so CeremonyPlugin's `.execute`
   * handler treats it as an external trigger and fires the ceremony — the
   * internal cron path uses `type: "ceremony.execute"` and is skipped to
   * avoid double-firing.
   */
  private async _execute(
    req: SkillRequest,
    entry: { skill: string; ceremonyId: string; description: string },
  ): Promise<SkillResult> {
    if (!this.bus) {
      return {
        text: "ceremony-skill-executor not installed",
        isError: true,
        correlationId: req.correlationId,
      };
    }

    const meta = (req.payload?.meta ?? {}) as Record<string, unknown>;
    const actionId = typeof meta.actionId === "string" ? meta.actionId : entry.skill;
    const goalId = typeof meta.goalId === "string" ? meta.goalId
      : typeof req.payload?.goalId === "string" ? req.payload.goalId
      : "unknown";

    const executeTopic = `ceremony.${entry.ceremonyId}.execute`;
    const triggerMsg: BusMessage = {
      id: crypto.randomUUID(),
      correlationId: req.correlationId,
      topic: executeTopic,
      timestamp: Date.now(),
      payload: {
        type: "external.trigger",
        source: "goap",
        actionId,
        goalId,
        skill: entry.skill,
        ceremonyId: entry.ceremonyId,
      },
    };
    this.bus.publish(executeTopic, triggerMsg);

    const text = `Triggered ceremony '${entry.ceremonyId}' — ${entry.description} (action ${actionId}, goal ${goalId})`;
    return {
      text,
      isError: false,
      correlationId: req.correlationId,
    };
  }
}
