/**
 * TypedActionRegistry types — preconditions, effects, cost, agent metadata.
 *
 * Actions are the core unit of the deterministic L0 planner.
 * Each action has:
 *   - preconditions: world-state checks that must pass before dispatch
 *   - effects: optimistic state mutations applied on dispatch
 *   - cost: resource/time cost (0 = free)
 *   - meta: agent routing and dispatch metadata
 */

export type ConditionOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "exists"
  | "not_exists";

/** A condition that must hold in the world state before an action can be dispatched. */
export interface Precondition {
  /** Dot-notation path into WorldState (e.g. "domains.board.data.inProgress"). */
  path: string;
  operator: ConditionOperator;
  /** Expected value (not required for exists/not_exists). */
  value?: unknown;
}

export type EffectOperation = "set" | "increment" | "decrement" | "delete";

/** A reversible mutation to WorldState.extensions applied optimistically on dispatch. */
export interface Effect {
  /** Dot-notation path within WorldState.extensions (e.g. "planner.auto_mode_running"). */
  path: string;
  operation: EffectOperation;
  value?: unknown;
}

/** Routing and execution metadata for an action. */
export interface ActionMeta {
  /** Agent ID to route the action to. */
  agentId?: string;
  /** Dispatch timeout in milliseconds. */
  timeout?: number;
  /** Arbitrary extra context passed through to the action handler. */
  context?: Record<string, unknown>;
  /** If true, publish to topic then immediately complete as success (no outcome wait). */
  fireAndForget?: boolean;
  /** Hint for SkillBrokerPlugin: which skill to invoke. */
  skillHint?: string;
}

export type ActionTier = "tier_0" | "tier_1" | "tier_2";

/**
 * A typed action definition.
 *
 * - tier_0: deterministic/free, handled by L0 rule engine
 * - tier_1: agent-assisted, routed to a specific agent
 * - tier_2: human-in-the-loop escalation
 */
export interface Action {
  id: string;
  name: string;
  description: string;
  /** The goal this action advances. */
  goalId: string;
  tier: ActionTier;
  /** Conditions that must all be true in WorldState before this action is dispatched. */
  preconditions: Precondition[];
  /** Optimistic state mutations applied immediately on dispatch (rolled back on failure). */
  effects: Effect[];
  /** Resource/time cost — 0 means free. Used for action selection. */
  cost: number;
  /** Higher value = selected first when multiple actions match. */
  priority: number;
  /**
   * Blast radius — number of unrelated world-state paths this action may touch as side effects.
   * Lower blast is safer; candidates with lower blast are preferred when effects are equivalent.
   * Defaults to 0 (no side effects).
   */
  blast?: number;
  /**
   * Confidence score for the declared effects, in the range [0.0, 1.0].
   * 1.0 = deterministic; lower values indicate probabilistic or uncertain effects.
   * Candidates with higher confidence are preferred. Defaults to 1.0.
   */
  confidence?: number;
  meta: ActionMeta;
}
