/**
 * A* search algorithm with cost tracking and budget-bounded execution.
 *
 * Finds least-cost plans through an action graph from initial state to goal.
 * Supports weighted A* for trading optimality for speed.
 */

import type {
  Action,
  Goal,
  Plan,
  PlannerState,
  SearchConfig,
  SearchNode,
  SearchResult,
} from "./types.ts";
import type { ActionGraph } from "./action-graph.ts";
import type { HeuristicFn } from "./heuristic.ts";
import { stateKey } from "./world-state.ts";
import { reconstructPlan, partialPlan, emptyPlan } from "./plan.ts";
import { applyEffects } from "./action.ts";

/**
 * Min-heap priority queue for SearchNodes, ordered by fScore.
 */
class MinHeap {
  private heap: SearchNode[] = [];

  get size(): number {
    return this.heap.length;
  }

  push(node: SearchNode): void {
    this.heap.push(node);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): SearchNode | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  peek(): SearchNode | undefined {
    return this.heap[0];
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[i].fScore >= this.heap[parent].fScore) break;
      [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.heap[left].fScore < this.heap[smallest].fScore) {
        smallest = left;
      }
      if (right < n && this.heap[right].fScore < this.heap[smallest].fScore) {
        smallest = right;
      }
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }
}

/**
 * Execute A* search on an action graph.
 *
 * @param graph - The action graph defining available actions
 * @param initial - The starting world state
 * @param goal - Predicate that tests if a state satisfies the goal
 * @param heuristic - Heuristic function estimating remaining cost
 * @param config - Optional search configuration (budget, weight, etc.)
 * @returns SearchResult with plan and statistics
 */
export function aStarSearch(
  graph: ActionGraph,
  initial: PlannerState,
  goal: Goal,
  heuristic: HeuristicFn,
  config: SearchConfig = {},
): SearchResult {
  const startTime = Date.now();
  const weight = config.weight ?? 1.0;
  const maxExpansions = config.maxExpansions ?? Infinity;
  const timeBudgetMs = config.timeBudgetMs ?? Infinity;

  const openSet = new MinHeap();
  const closedSet = new Set<string>();
  const gScores = new Map<string, number>();

  let nodesExpanded = 0;
  let nodesGenerated = 1;
  let bestGoalNode: SearchNode | null = null;
  let bestFrontierNode: SearchNode | null = null;

  // Initialize with start node
  const startKey = stateKey(initial);
  const startNode: SearchNode = {
    state: initial,
    stateKey: startKey,
    parent: null,
    action: null,
    gScore: 0,
    fScore: weight * heuristic(initial, goal),
  };
  openSet.push(startNode);
  gScores.set(startKey, 0);

  // Check if initial state already satisfies goal
  if (goal(initial)) {
    return {
      plan: { actions: [], totalCost: 0, isComplete: true },
      nodesExpanded: 0,
      nodesGenerated: 1,
      elapsedMs: Date.now() - startTime,
      exhaustive: true,
    };
  }

  while (openSet.size > 0) {
    // Budget checks
    if (nodesExpanded >= maxExpansions) break;
    if (Date.now() - startTime >= timeBudgetMs) break;

    const current = openSet.pop()!;

    // Skip if we already found a better path to this state
    if (closedSet.has(current.stateKey)) continue;
    closedSet.add(current.stateKey);
    nodesExpanded++;

    // Track best frontier node for partial plans
    if (bestFrontierNode === null || current.fScore < bestFrontierNode.fScore) {
      bestFrontierNode = current;
    }

    // Check goal on pop (not on generation) — guarantees optimality
    if (goal(current.state)) {
      if (bestGoalNode === null || current.gScore < bestGoalNode.gScore) {
        bestGoalNode = current;
      }
      if (weight <= 1.0) {
        return {
          plan: reconstructPlan(current),
          nodesExpanded,
          nodesGenerated,
          elapsedMs: Date.now() - startTime,
          exhaustive: true,
        };
      }
      continue;
    }

    // Expand successors
    const successors = graph.getSuccessors(current.state);

    for (const { action, resultState } of successors) {
      const key = stateKey(resultState);
      if (closedSet.has(key)) continue;

      const tentativeG = current.gScore + action.cost;
      const existingG = gScores.get(key);

      if (existingG !== undefined && tentativeG >= existingG) continue;

      gScores.set(key, tentativeG);
      nodesGenerated++;

      const h = heuristic(resultState, goal);
      const node: SearchNode = {
        state: resultState,
        stateKey: key,
        parent: current,
        action,
        gScore: tentativeG,
        fScore: tentativeG + weight * h,
      };

      openSet.push(node);
    }
  }

  const elapsedMs = Date.now() - startTime;
  const exhaustive = openSet.size === 0;

  // Return best goal plan if found
  if (bestGoalNode !== null) {
    return {
      plan: reconstructPlan(bestGoalNode),
      nodesExpanded,
      nodesGenerated,
      elapsedMs,
      exhaustive,
    };
  }

  // Return partial plan from best frontier node
  if (bestFrontierNode !== null && bestFrontierNode.action !== null) {
    const lowerBound = bestFrontierNode.fScore;
    return {
      plan: partialPlan(bestFrontierNode, lowerBound),
      nodesExpanded,
      nodesGenerated,
      elapsedMs,
      exhaustive,
    };
  }

  // No plan found at all
  return {
    plan: emptyPlan(),
    nodesExpanded,
    nodesGenerated,
    elapsedMs,
    exhaustive,
  };
}
