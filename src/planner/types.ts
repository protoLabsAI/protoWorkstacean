/**
 * Core type definitions for the L1 A* planner system.
 *
 * The planner operates on flat key-value state maps where:
 * - World states are nodes in the action graph
 * - Actions are directed edges between states
 * - A* search finds least-cost paths from initial to goal state
 */

// ── State types ──────────────────────────────────────────────────────────────

/** Primitive values that can appear in planner state. */
export type StateValue = string | number | boolean | null;

/** Immutable flat key-value map representing a planner world state. */
export type PlannerState = Readonly<Record<string, StateValue>>;

/** A predicate that tests whether a state satisfies some condition. */
export type StatePredicate = (state: PlannerState) => boolean;

/** A function that produces a new state from an existing one (must not mutate input). */
export type StateTransform = (state: PlannerState) => PlannerState;

// ── Hierarchy ────────────────────────────────────────────────────────────────

/** HTN decomposition levels, from most abstract to most concrete. */
export type HierarchyLevel = "portfolio" | "project" | "domain" | "action";

/** Ordered hierarchy from abstract to concrete. */
export const HIERARCHY_ORDER: readonly HierarchyLevel[] = [
  "portfolio",
  "project",
  "domain",
  "action",
] as const;

// ── Action types ─────────────────────────────────────────────────────────────

/** A primitive action that can be executed in the planner. */
export interface Action {
  id: string;
  name: string;
  cost: number;
  level: HierarchyLevel;
  preconditions: StatePredicate[];
  effects: StateTransform[];
  /** Optional metadata for HTN decomposition. */
  meta?: Record<string, unknown>;
}

/** A composite task in the HTN hierarchy that decomposes into sub-tasks. */
export interface CompositeTask {
  id: string;
  name: string;
  level: HierarchyLevel;
  /** Returns ordered list of sub-task IDs or Actions to decompose into. */
  decompose: (state: PlannerState) => Array<string | Action>;
  /** Optional precondition for applicability at this level. */
  precondition?: StatePredicate;
}

// ── Plan types ───────────────────────────────────────────────────────────────

/** A sequence of actions forming a plan. */
export interface Plan {
  actions: Action[];
  totalCost: number;
  isComplete: boolean;
  /** Lower bound on optimal cost (for anytime search). */
  lowerBound?: number;
}

/** Result of plan validation. */
export interface ValidationResult {
  valid: boolean;
  /** Index of first action that failed validation (-1 if all passed). */
  failedAtIndex: number;
  /** Final state after executing valid actions. */
  finalState: PlannerState;
  /** Error message if validation failed. */
  error?: string;
}

// ── Goal types ───────────────────────────────────────────────────────────────

/** A goal is a predicate on world state that the planner tries to satisfy. */
export type Goal = StatePredicate;

/** Named goal with metadata. */
export interface NamedGoal {
  id: string;
  name: string;
  test: Goal;
  /** Optional heuristic estimate of cost to achieve this goal from a given state. */
  heuristic?: (state: PlannerState) => number;
}

// ── Search types ─────────────────────────────────────────────────────────────

/** A node in the A* search graph. */
export interface SearchNode {
  state: PlannerState;
  stateKey: string;
  parent: SearchNode | null;
  action: Action | null;
  /** Cost from start (g-score). */
  gScore: number;
  /** Estimated total cost (f-score = g + h). */
  fScore: number;
}

/** Configuration for A* search. */
export interface SearchConfig {
  /** Maximum number of nodes to expand before stopping. */
  maxExpansions?: number;
  /** Time budget in milliseconds. */
  timeBudgetMs?: number;
  /** Weight for weighted A* (>1 trades optimality for speed). */
  weight?: number;
}

/** Result of an A* search. */
export interface SearchResult {
  plan: Plan;
  nodesExpanded: number;
  nodesGenerated: number;
  elapsedMs: number;
  /** Whether search was exhaustive or cut short by budget. */
  exhaustive: boolean;
}

// ── Budget types ─────────────────────────────────────────────────────────────

/** Budget configuration for anytime planning. */
export interface BudgetConfig {
  timeBudgetMs: number;
  maxExpansions?: number;
}

/** Status of budget consumption. */
export interface BudgetStatus {
  elapsedMs: number;
  expansionsUsed: number;
  timeRemaining: number;
  isExhausted: boolean;
}

// ── L0/L1 bridge types ──────────────────────────────────────────────────────

/** Context passed from L0 rule matcher to L1 planner. */
export interface L0Context {
  currentState: PlannerState;
  goal: Goal;
  namedGoal?: NamedGoal;
  /** Why L0 could not handle this (e.g., "no matching rule"). */
  reason: string;
}

/** Result from L1 planner back to the system. */
export interface L1Result {
  success: boolean;
  plan?: Plan;
  validationResult?: ValidationResult;
  searchResult?: SearchResult;
  error?: string;
}
