/**
 * Introspection — APIs for inspecting planner state, action queue,
 * dispatch history, loop detection status, and EventBus subscriptions.
 */

import type { EventBus } from "../../lib/types.ts";
import type { ActionRegistry } from "./action-registry.ts";
import type { PlannerPluginL0 } from "../plugins/planner-plugin-l0.ts";
import type { ActionDispatcherPlugin } from "../plugins/action-dispatcher-plugin.ts";

export interface PlannerStatus {
  /** All registered actions. */
  registeredActions: Array<{
    id: string;
    name: string;
    goalId: string;
    tier: string;
    cost: number;
    priority: number;
    preconditionCount: number;
    effectCount: number;
  }>;
  /** WIP queue status. */
  queue: {
    activeCount: number;
    pendingCount: number;
    wipLimit: number;
  };
  /** Outcome summary. */
  outcomes: {
    success: number;
    failure: number;
    timeout: number;
    total: number;
  };
  /** Loop detection status per (goalId:actionId). */
  loopStatus: Array<{
    key: string;
    recentFailureCount: number;
    isOscillating: boolean;
    isOnCooldown: boolean;
  }>;
  /** EventBus subscriptions for planner topics. */
  subscriptions: Array<{
    pattern: string;
    subscribers: number;
  }>;
}

export class PlannerIntrospection {
  constructor(
    private readonly registry: ActionRegistry,
    private readonly planner: PlannerPluginL0,
    private readonly dispatcher: ActionDispatcherPlugin,
    private readonly bus: EventBus
  ) {}

  /** Return a comprehensive snapshot of the planner subsystem state. */
  getStatus(): PlannerStatus {
    const actions = this.registry.getAll();
    const loopDetector = this.planner.getLoopDetector();
    const cooldownManager = this.planner.getCooldownManager();
    const queue = this.dispatcher.getQueue();
    const outcomes = this.dispatcher.getOutcomes();

    // Collect loop/cooldown status for all known (goalId, actionId) pairs
    const loopStatus = actions.map((a) => ({
      key: `${a.goalId}:${a.id}`,
      recentFailureCount: loopDetector.getRecentFailures(a.goalId, a.id).length,
      isOscillating: loopDetector.isOscillating(a.goalId, a.id),
      isOnCooldown: cooldownManager.isOnCooldown(a.goalId, a.id),
    }));

    // Filter bus topics to planner-relevant ones
    const plannerTopicPrefixes = ["world.action.", "world.state.", "world.planner."];
    const subscriptions = this.bus
      .topics()
      .filter((t) => plannerTopicPrefixes.some((prefix) => t.pattern.startsWith(prefix)));

    return {
      registeredActions: actions.map((a) => ({
        id: a.id,
        name: a.name,
        goalId: a.goalId,
        tier: a.tier,
        cost: a.cost,
        priority: a.priority,
        preconditionCount: a.preconditions.length,
        effectCount: a.effects.length,
      })),
      queue: {
        activeCount: queue.activeCount,
        pendingCount: queue.pendingCount,
        wipLimit: queue.wipLimit,
      },
      outcomes: outcomes.summary(),
      loopStatus,
      subscriptions,
    };
  }

  /** Return recent dispatch history. */
  getRecentOutcomes(n = 20) {
    return this.dispatcher.getOutcomes().getRecent(n);
  }

  /** Return pending actions in the WIP queue. */
  getPendingActions() {
    return this.dispatcher.getQueue().getPending();
  }
}
