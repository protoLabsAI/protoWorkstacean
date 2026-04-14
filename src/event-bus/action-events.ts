/**
 * Typed payloads for world.action.* EventBus topics.
 *
 * These are the payload types for BusMessage.payload when publishing/receiving
 * action dispatch and outcome events.
 */

import type { Action } from "../planner/types/action.ts";

/** Payload for world.action.dispatch — published when an action is dispatched. */
export interface ActionDispatchPayload {
  type: "dispatch";
  actionId: string;
  goalId: string;
  action: Action;
  correlationId: string;
  timestamp: number;
  /** Whether optimistic effects were applied to the world state. */
  optimisticEffectsApplied: boolean;
}

/** Payload for world.action.oscillation — published on loop detection breach. */
export interface ActionOscillationPayload {
  type: "oscillation";
  actionId: string;
  goalId: string;
  timestamp: number;
  /** Full failure history within the detection window. */
  history: Array<{ timestamp: number; succeeded: boolean }>;
}

/** Payload for world.action.queue_full — published when WIP limit is reached. */
export interface ActionQueueFullPayload {
  type: "queue_full";
  timestamp: number;
  /** Number of actions currently in the WIP queue. */
  wipCount: number;
  /** Configured WIP limit. */
  wipLimit: number;
  /** The action ID that was rejected/queued due to WIP limit. */
  pendingActionId: string;
}

/** Payload for world.planner.escalate — published when L0 cannot handle a goal. */
export interface PlannerEscalatePayload {
  type: "escalate";
  goalId: string;
  actionId?: string;
  correlationId: string;
  timestamp: number;
  reason: string;
  /** Target tier for escalation. */
  escalateTo: "tier_1" | "tier_2" | "manual";
}
