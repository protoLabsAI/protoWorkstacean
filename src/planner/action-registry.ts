/**
 * ActionRegistry — thread-safe registry for typed action definitions.
 *
 * Stores, validates, and retrieves actions.
 * Supports:
 *   - precondition/effect validation on registration
 *   - cost calculation helpers
 *   - agent assignment lookup
 *   - lazy loading via register()
 */

import type { Action } from "./types/action.ts";

export class ActionRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionRegistryError";
  }
}

export class ActionRegistry {
  private readonly actions = new Map<string, Action>();

  /** Register an action. Throws if invalid or duplicate ID. */
  register(action: Action): void {
    this.validate(action);
    if (this.actions.has(action.id)) {
      throw new ActionRegistryError(`Action '${action.id}' is already registered. Unregister first.`);
    }
    this.actions.set(action.id, action);
  }

  /** Register or replace an action (upsert). */
  upsert(action: Action): void {
    this.validate(action);
    this.actions.set(action.id, action);
  }

  /** Look up a single action by ID. */
  get(id: string): Action | undefined {
    return this.actions.get(id);
  }

  /** Return all registered actions. */
  getAll(): Action[] {
    return Array.from(this.actions.values());
  }

  /** Return all actions for a given goal. */
  getByGoal(goalId: string): Action[] {
    return this.getAll().filter((a) => a.goalId === goalId);
  }

  /** Return all tier_0 actions (deterministic/free). */
  getTier0(): Action[] {
    return this.getAll().filter((a) => a.tier === "tier_0");
  }

  /** Remove an action by ID. No-op if not found. */
  unregister(id: string): void {
    this.actions.delete(id);
  }

  /** Remove all registered actions. Used for atomic hot-reload. */
  clear(): void {
    this.actions.clear();
  }

  /** Number of registered actions. */
  get size(): number {
    return this.actions.size;
  }

  /** Total cost of all actions for a given goal. */
  totalCost(goalId: string): number {
    return this.getByGoal(goalId).reduce((sum, a) => sum + a.cost, 0);
  }

  /** Return all unique agent IDs referenced by registered actions. */
  agentIds(): string[] {
    const ids = new Set<string>();
    for (const action of this.actions.values()) {
      if (action.meta.agentId) ids.add(action.meta.agentId);
    }
    return Array.from(ids);
  }

  private validate(action: Action): void {
    if (!action.id || action.id.trim() === "") {
      throw new ActionRegistryError("Action must have a non-empty id");
    }
    if (!action.name || action.name.trim() === "") {
      throw new ActionRegistryError(`Action '${action.id}' must have a non-empty name`);
    }
    if (!action.goalId || action.goalId.trim() === "") {
      throw new ActionRegistryError(`Action '${action.id}' must have a non-empty goalId`);
    }
    if (!["tier_0", "tier_1", "tier_2"].includes(action.tier)) {
      throw new ActionRegistryError(`Action '${action.id}' has invalid tier '${action.tier}'`);
    }
    if (action.cost < 0) {
      throw new ActionRegistryError(`Action '${action.id}' cost must be >= 0`);
    }
    if (!Array.isArray(action.preconditions)) {
      throw new ActionRegistryError(`Action '${action.id}' preconditions must be an array`);
    }
    if (!Array.isArray(action.effects)) {
      throw new ActionRegistryError(`Action '${action.id}' effects must be an array`);
    }

    // Validate preconditions
    for (const p of action.preconditions) {
      if (!p.path || p.path.trim() === "") {
        throw new ActionRegistryError(`Action '${action.id}' precondition path must be non-empty`);
      }
      const validOps = ["eq", "neq", "gt", "gte", "lt", "lte", "exists", "not_exists"];
      if (!validOps.includes(p.operator)) {
        throw new ActionRegistryError(
          `Action '${action.id}' precondition operator '${p.operator}' is invalid`
        );
      }
    }

    // Validate effects
    for (const e of action.effects) {
      if (!e.path || e.path.trim() === "") {
        throw new ActionRegistryError(`Action '${action.id}' effect path must be non-empty`);
      }
      const validOps = ["set", "increment", "decrement", "delete"];
      if (!validOps.includes(e.operation)) {
        throw new ActionRegistryError(
          `Action '${action.id}' effect operation '${e.operation}' is invalid`
        );
      }
    }
  }
}
