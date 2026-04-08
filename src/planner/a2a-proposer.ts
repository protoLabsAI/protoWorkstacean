/**
 * A2AProposer — LLM-based candidate plan proposer via Agent-to-Agent protocol.
 *
 * Sends the current state + goal to Ava (LLM agent) and receives candidate plans.
 * The A2A interface is abstracted so tests can provide mock proposers.
 */

import type { Action, Goal, Plan, PlannerState } from "./types.ts";
import type { CandidatePlan, L2Context } from "./routing-interface.ts";

/** Interface for A2A communication with an LLM agent. */
export interface A2AClient {
  /**
   * Request candidate plans from the LLM agent.
   *
   * @param prompt - Structured prompt describing state, goal, and available actions
   * @param maxCandidates - Maximum number of candidate plans to request
   * @returns Array of candidate plans
   */
  proposePlans(prompt: A2APrompt, maxCandidates: number): Promise<CandidatePlan[]>;
}

/** Structured prompt sent to the LLM agent. */
export interface A2APrompt {
  /** Current world state as key-value pairs. */
  state: PlannerState;
  /** Human-readable goal description. */
  goalDescription: string;
  /** Goal ID if available. */
  goalId?: string;
  /** Available actions the LLM can use in its plan. */
  availableActions: ActionSummary[];
  /** Context about why lower layers failed. */
  failureContext: string[];
  /** Maximum plan length. */
  maxPlanLength: number;
}

/** Simplified action description for the LLM. */
export interface ActionSummary {
  id: string;
  name: string;
  cost: number;
  /** Human-readable preconditions. */
  preconditionsSummary: string;
  /** Human-readable effects. */
  effectsSummary: string;
}

export class A2AProposer {
  constructor(private client: A2AClient) {}

  /**
   * Generate candidate plans by querying the LLM via A2A.
   */
  async propose(
    context: L2Context,
    availableActions: readonly Action[],
    maxCandidates: number = 3,
  ): Promise<CandidatePlan[]> {
    const prompt = this.buildPrompt(context, availableActions);
    return this.client.proposePlans(prompt, maxCandidates);
  }

  /**
   * Build a structured A2A prompt from context.
   */
  private buildPrompt(
    context: L2Context,
    availableActions: readonly Action[],
  ): A2APrompt {
    const actionSummaries: ActionSummary[] = availableActions.map((a) => ({
      id: a.id,
      name: a.name,
      cost: a.cost,
      preconditionsSummary: `${a.preconditions.length} preconditions`,
      effectsSummary: `${a.effects.length} effects`,
    }));

    const failureReasons = context.failures.map(
      (f) => `${f.layer.toUpperCase()} failed: ${f.reason}`,
    );

    return {
      state: context.currentState,
      goalDescription: context.namedGoal?.name ?? "unnamed goal",
      goalId: context.namedGoal?.id,
      availableActions: actionSummaries,
      failureContext: failureReasons,
      maxPlanLength: 20,
    };
  }
}

/**
 * NoOpA2AClient — returns empty candidates. Used as default when no LLM is configured.
 */
export class NoOpA2AClient implements A2AClient {
  async proposePlans(_prompt: A2APrompt, _maxCandidates: number): Promise<CandidatePlan[]> {
    return [];
  }
}
