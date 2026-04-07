/**
 * Action creation helpers and utilities.
 */

import type {
  Action,
  HierarchyLevel,
  PlannerState,
  StatePredicate,
  StateTransform,
  StateValue,
} from "./types.ts";
import { applyUpdate } from "./world-state.ts";

/** Builder for creating actions with a fluent API. */
export class ActionBuilder {
  private _id: string;
  private _name: string;
  private _cost = 1;
  private _level: HierarchyLevel = "action";
  private _preconditions: StatePredicate[] = [];
  private _effects: StateTransform[] = [];
  private _meta: Record<string, unknown> = {};

  constructor(id: string, name: string) {
    this._id = id;
    this._name = name;
  }

  cost(c: number): this {
    this._cost = c;
    return this;
  }

  level(l: HierarchyLevel): this {
    this._level = l;
    return this;
  }

  /** Add a precondition that checks if a key equals a specific value. */
  requireEquals(key: string, value: StateValue): this {
    this._preconditions.push((s) => s[key] === value);
    return this;
  }

  /** Add a precondition that checks if a key is truthy. */
  requireTruthy(key: string): this {
    this._preconditions.push((s) => !!s[key]);
    return this;
  }

  /** Add a custom precondition. */
  require(pred: StatePredicate): this {
    this._preconditions.push(pred);
    return this;
  }

  /** Add an effect that sets key-value pairs. */
  set(updates: Record<string, StateValue>): this {
    this._effects.push((s) => applyUpdate(s, updates));
    return this;
  }

  /** Add a custom effect transform. */
  effect(transform: StateTransform): this {
    this._effects.push(transform);
    return this;
  }

  meta(m: Record<string, unknown>): this {
    this._meta = { ...this._meta, ...m };
    return this;
  }

  build(): Action {
    return {
      id: this._id,
      name: this._name,
      cost: this._cost,
      level: this._level,
      preconditions: [...this._preconditions],
      effects: [...this._effects],
      meta: Object.keys(this._meta).length > 0 ? { ...this._meta } : undefined,
    };
  }
}

/** Shorthand to create an ActionBuilder. */
export function action(id: string, name: string): ActionBuilder {
  return new ActionBuilder(id, name);
}

/** Check if all preconditions of an action are satisfied by the given state. */
export function preconditionsMet(a: Action, state: PlannerState): boolean {
  return a.preconditions.every((p) => p(state));
}

/** Apply all effects of an action to a state, returning the new state. */
export function applyEffects(a: Action, state: PlannerState): PlannerState {
  let current = state;
  for (const eff of a.effects) {
    current = eff(current);
  }
  return current;
}
