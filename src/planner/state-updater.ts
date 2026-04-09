/**
 * StateUpdater — applies optimistic Effect mutations to WorldState.extensions.
 *
 * Returns a new (mutated) WorldState and a rollback function that returns
 * the original state. All mutations are shallow-cloned to avoid aliasing.
 */

import type { Effect } from "./types/action.ts";
import type { WorldState } from "../../lib/types/world-state.ts";

/** Deep-clone a plain JSON-serializable object. */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Resolve a dot-notation path within an object and return [parent, key].
 * Creates intermediate objects if they don't exist (for 'set'/'increment').
 */
function resolveParent(
  obj: Record<string, unknown>,
  path: string
): [Record<string, unknown>, string] {
  const parts = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  return [current, parts[parts.length - 1]];
}

/** Apply a single effect to a mutable extensions object. */
function applyEffect(extensions: Record<string, unknown>, effect: Effect): void {
  const [parent, key] = resolveParent(extensions, effect.path);

  switch (effect.operation) {
    case "set":
      parent[key] = effect.value;
      break;
    case "increment": {
      const current = typeof parent[key] === "number" ? (parent[key] as number) : 0;
      parent[key] = current + ((effect.value as number) ?? 1);
      break;
    }
    case "decrement": {
      const current = typeof parent[key] === "number" ? (parent[key] as number) : 0;
      parent[key] = current - ((effect.value as number) ?? 1);
      break;
    }
    case "delete":
      delete parent[key];
      break;
  }
}

export interface ApplyResult {
  /** The new WorldState with effects applied. */
  updatedState: WorldState;
  /** Call this to get the original state back (rollback). */
  rollback: () => WorldState;
}

/**
 * Apply a list of effects to WorldState.extensions optimistically.
 *
 * Returns the updated state and a rollback function.
 * The original state is never mutated.
 */
export function applyEffects(worldState: WorldState, effects: Effect[]): ApplyResult {
  if (effects.length === 0) {
    return { updatedState: worldState, rollback: () => worldState };
  }

  const original = deepClone(worldState);
  const updated = deepClone(worldState);

  for (const effect of effects) {
    applyEffect(updated.extensions, effect);
  }

  return {
    updatedState: updated,
    rollback: () => deepClone(original),
  };
}
