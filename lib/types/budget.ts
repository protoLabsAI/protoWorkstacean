/**
 * Budget system types — cost-aware execution tiers, tracking, circuit breakers,
 * and HITL escalation context.
 *
 * Daily caps:
 *   MAX_PROJECT_BUDGET = $10 per project per day
 *   MAX_DAILY_BUDGET   = $50 total across all projects per day
 *
 * Tier routing (based on max_cost + remaining budget):
 *   L0 → max_cost < $0.10  AND remaining > 50% → fully autonomous
 *   L1 → max_cost < $1.00  AND remaining > 25% → notify, proceed
 *   L2 → max_cost < $5.00  AND remaining > 10% → soft-gate, log warning
 *   L3 → otherwise                              → HITL escalation required
 */

// ── Budget constants ────────────────────────────────────────────────────────

export const MAX_PROJECT_BUDGET = 10.0;  // $10 per project per day
export const MAX_DAILY_BUDGET = 50.0;    // $50 total per day

// ── Tier definitions ────────────────────────────────────────────────────────

export type BudgetTierLevel = "L0" | "L1" | "L2" | "L3";

export interface TierThresholds {
  maxCost: number;         // Max estimated cost ceiling for automatic assignment to this tier
  minBudgetRatio: number;  // Minimum remaining budget ratio (0–1) required to stay in this tier
  label: string;
  requiresHITL: boolean;
}

export const TIER_CONFIG: Record<BudgetTierLevel, TierThresholds> = {
  L0: { maxCost: 0.10,     minBudgetRatio: 0.50, label: "Autonomous",    requiresHITL: false },
  L1: { maxCost: 1.00,     minBudgetRatio: 0.25, label: "Notify",        requiresHITL: false },
  L2: { maxCost: 5.00,     minBudgetRatio: 0.10, label: "Soft-gate",     requiresHITL: false },
  L3: { maxCost: Infinity, minBudgetRatio: 0,    label: "HITL Required", requiresHITL: true  },
};

// ── Cost estimation ─────────────────────────────────────────────────────────

/** Per-token costs in USD for known models (input, output) */
export const MODEL_RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6":            { input: 0.000015,   output: 0.000075   },
  "claude-sonnet-4-6":          { input: 0.000003,   output: 0.000015   },
  "claude-haiku-4-5":           { input: 0.00000025, output: 0.00000125 },
  "claude-haiku-4-5-20251001":  { input: 0.00000025, output: 0.00000125 },
  // OpenAI compat fallback
  "gpt-4o":                     { input: 0.0000025,  output: 0.00001    },
  "gpt-4o-mini":                { input: 0.00000015, output: 0.0000006  },
  "default":                    { input: 0.000003,   output: 0.000015   },
};

export const FALLBACK_COST_MULTIPLIER = 1.5; // Conservative upper bound per deviation rules

export interface CostEstimate {
  promptTokens: number;
  completionTokens: number;
  estimatedCost: number;      // Best estimate
  maxCost: number;             // Conservative upper bound (1.5×)
  modelId: string;
  fallbackUsed: boolean;
}

// ── Budget state ─────────────────────────────────────────────────────────────

export interface BudgetState {
  projectId: string;
  agentId: string;
  /** Spend by this agent across all projects today */
  agentDailySpend: number;
  /** Spend for this project today */
  projectDailySpend: number;
  /** Total spend across all agents/projects today */
  totalDailySpend: number;
  remainingProjectBudget: number;
  remainingDailyBudget: number;
  /** remainingProjectBudget / MAX_PROJECT_BUDGET */
  projectBudgetRatio: number;
  /** remainingDailyBudget / MAX_DAILY_BUDGET */
  dailyBudgetRatio: number;
}

// ── Budget ledger records ─────────────────────────────────────────────────

export interface BudgetRecord {
  id: string;
  timestamp: number;
  agentId: string;
  projectId: string;
  goalId: string | null;
  requestId: string;
  tier: BudgetTierLevel;
  estimatedCost: number;
  actualCost: number | null;
  wasEscalated: boolean;
  wasAutonomous: boolean;
}

// ── Circuit breaker ──────────────────────────────────────────────────────────

export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitState {
  /** Composite key: `${goalId}:${agentId}` */
  key: string;
  state: CircuitBreakerState;
  failureCount: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  openedAt: number | null;
}

// ── Escalation context ───────────────────────────────────────────────────────

export interface EscalationContext {
  requestId: string;
  agentId: string;
  projectId: string;
  goalId: string | null;
  estimatedCost: number;
  maxCost: number;
  tier: BudgetTierLevel;
  /** Human-readable reason for escalation */
  escalation_reason: string;
  /** Recent cost history for this agent/project */
  cost_trail: BudgetRecord[];
  budgetState: BudgetState;
  timestamp: number;
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export interface BudgetMetrics {
  totalRequests: number;
  autonomousRequests: number;
  escalatedRequests: number;
  /** Fraction 0–1; target is 0.85–0.90 */
  autonomous_rate: number;
  totalCost: number;
  averageCost: number;
  period: "day" | "week" | "all";
  computedAt: number;
}

// ── Bus message payloads ──────────────────────────────────────────────────────

export interface BudgetRequest {
  type: "budget_request";
  requestId: string;
  agentId: string;
  projectId: string;
  goalId?: string;
  modelId?: string;
  /** Approximate prompt text for token estimation */
  promptText?: string;
  estimatedPromptTokens?: number;
  estimatedCompletionTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface BudgetDecision {
  type: "budget_decision";
  requestId: string;
  tier: BudgetTierLevel;
  approved: boolean;
  estimatedCost: number;
  maxCost: number;
  budgetState: BudgetState;
  escalationContext?: EscalationContext;
  reason: string;
}

export interface BudgetActual {
  type: "budget_actual";
  requestId: string;
  agentId: string;
  projectId: string;
  goalId?: string;
  actualCost: number;
  actualPromptTokens?: number;
  actualCompletionTokens?: number;
}
