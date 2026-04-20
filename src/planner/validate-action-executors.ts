/**
 * validate-action-executors — fail-loud cross-check between actions.yaml
 * and the live ExecutorRegistry.
 *
 * For every loaded action, compute the skill name that ActionDispatcherPlugin
 * will publish on `agent.skill.request` (skillHint > action.id) and the
 * routing target (meta.agentId, when set). Confirm the registry can resolve
 * a non-null IExecutor for that pair. If anything is unresolvable, log a
 * console.error (always) and publish a HIGH-severity Discord alert so the
 * gap surfaces in the operator dashboard instead of being buried in logs.
 *
 * Called once at startup AFTER all registrar plugins (agent-runtime,
 * skill-broker, alert-skill-executor, ceremony-skill-executor) have installed. Pre-existing
 * unwired actions don't crash the process — but each one is a feature
 * request signal that the GOAP loop is dispatching into the void on
 * every planning cycle (issue #426).
 *
 * In strict mode (`{ throwOnUnwired: true }`) the function throws an
 * UnwiredActionsError instead. Used by tests and operators who want
 * the build/CI to break on regressions.
 */

import type { ActionRegistry } from "./action-registry.ts";
import type { ExecutorRegistry } from "../executor/executor-registry.ts";
import type { EventBus, BusMessage } from "../../lib/types.ts";

export interface UnwiredAction {
  /** Action id from actions.yaml. */
  actionId: string;
  /** The skill name that would be published on agent.skill.request. */
  skill: string;
  /** Routing target derived from meta.agentId (empty when none). */
  targets: string[];
}

export class UnwiredActionsError extends Error {
  readonly unwired: UnwiredAction[];
  constructor(unwired: UnwiredAction[]) {
    const lines = unwired.map(
      u => `  - action '${u.actionId}' → skill '${u.skill}'${u.targets.length > 0 ? ` (targets: ${u.targets.join(", ")})` : ""}`,
    );
    super(
      `${unwired.length} action(s) in workspace/actions.yaml reference skill(s) ` +
      `with no registered executor. Each missing executor would cause ` +
      `SkillDispatcherPlugin to silently drop the dispatch on every GOAP ` +
      `planning cycle.\n${lines.join("\n")}\n` +
      `Fix: register an executor (agent-runtime, skill-broker, alert-skill-executor, ` +
      `ceremony-skill-executor, or a FunctionExecutor) for each skill, or remove the action from ` +
      `workspace/actions.yaml.`,
    );
    this.name = "UnwiredActionsError";
    this.unwired = unwired;
  }
}

/**
 * Scan ActionRegistry against ExecutorRegistry and return every action whose
 * (skill, targets) pair resolves to a null executor.
 *
 * Mirrors the resolution rules of ActionDispatcherPlugin._dispatch():
 *   skill   = action.meta.skillHint ?? action.id
 *   targets = action.meta.agentId ? [action.meta.agentId] : []
 *
 * and SkillDispatcherPlugin._dispatch():
 *   executor = registry.resolve(skill, targets)
 */
export function findUnwiredActions(
  actions: ActionRegistry,
  executors: ExecutorRegistry,
): UnwiredAction[] {
  const unwired: UnwiredAction[] = [];
  for (const action of actions.getAll()) {
    const meta = (action.meta ?? {}) as Record<string, unknown>;
    const skill = (typeof meta.skillHint === "string" && meta.skillHint) || action.id;
    const targets = typeof meta.agentId === "string" && meta.agentId ? [meta.agentId] : [];
    const executor = executors.resolve(skill, targets);
    if (!executor) {
      unwired.push({ actionId: action.id, skill, targets });
    }
  }
  return unwired;
}

export interface ValidateOptions {
  /** Throw UnwiredActionsError if any actions are unwired. Default: false. */
  throwOnUnwired?: boolean;
  /**
   * EventBus for publishing a HIGH-severity Discord alert per unwired action.
   * When omitted, only the console.error path runs. Pass the live bus from
   * src/index.ts so operators see the gap in the alerts channel.
   */
  bus?: EventBus;
}

/**
 * Validate every loaded action has a resolvable executor. Logs to console
 * and (optionally) publishes a HIGH-severity Discord alert per gap. Throws
 * an UnwiredActionsError when `opts.throwOnUnwired` is set.
 *
 * Returns the list of unwired actions so callers can branch on the result
 * without needing to subscribe to the alert topic.
 */
export function validateActionExecutors(
  actions: ActionRegistry,
  executors: ExecutorRegistry,
  opts: ValidateOptions = {},
): UnwiredAction[] {
  const unwired = findUnwiredActions(actions, executors);
  if (unwired.length === 0) return unwired;

  // Always log loudly — the dispatcher's per-cycle "No executor found" warning
  // is a symptom; this is the diagnosis, printed once at startup with full
  // context and a fix recommendation.
  console.error(
    `[startup-validator] ${unwired.length} action(s) reference unwired skills:`,
  );
  for (const u of unwired) {
    const tgt = u.targets.length > 0 ? ` targets=[${u.targets.join(", ")}]` : "";
    console.error(`[startup-validator]   - ${u.actionId} → skill='${u.skill}'${tgt}`);
  }
  console.error(
    `[startup-validator] Each gap silently drops on every GOAP planning cycle. ` +
    `Wire an executor or remove the action from workspace/actions.yaml.`,
  );

  if (opts.bus) {
    for (const u of unwired) {
      const text = `Action \`${u.actionId}\` references skill \`${u.skill}\` with no registered executor — every GOAP dispatch will silently drop. (issue #426)`;
      const alertMsg: BusMessage = {
        id: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        topic: "message.outbound.discord.alert",
        timestamp: Date.now(),
        payload: {
          text,
          actionId: u.actionId,
          goalId: "platform.skills_unwired",
          meta: {
            severity: "high",
            agentId: "startup-validator",
            extra: { skill: u.skill, targets: u.targets },
          },
        },
      };
      opts.bus.publish("message.outbound.discord.alert", alertMsg);
    }
  }

  if (opts.throwOnUnwired) {
    throw new UnwiredActionsError(unwired);
  }
  return unwired;
}
