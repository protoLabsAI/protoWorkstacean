import type { StateDiff, StateDiffEntry, WorldState } from "../types/state_diff.ts";

/**
 * Resolves a dot-notation path into an object.
 * e.g. resolvePath({ a: { b: 1 } }, "a.b") => 1
 */
export function resolvePath(obj: unknown, path: string): { found: boolean; value: unknown } {
  if (!path) return { found: true, value: obj };

  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return { found: false, value: undefined };
    }
    if (typeof current !== "object") {
      return { found: false, value: undefined };
    }
    const record = current as Record<string, unknown>;
    if (!(part in record)) {
      return { found: false, value: undefined };
    }
    current = record[part];
  }

  return { found: true, value: current };
}

/**
 * Diffs two world states field-by-field.
 * Returns all entries where actual differs from expected.
 */
export class StateDiffEngine {
  diff(expected: WorldState, actual: WorldState): StateDiff {
    const entries: StateDiffEntry[] = [];

    this._diffObjects(expected, actual, "", entries);

    return {
      entries,
      hasChanges: entries.length > 0,
    };
  }

  private _diffObjects(
    expected: Record<string, unknown>,
    actual: Record<string, unknown>,
    prefix: string,
    entries: StateDiffEntry[],
  ): void {
    const allKeys = new Set([...Object.keys(expected), ...Object.keys(actual)]);

    for (const key of allKeys) {
      const path = prefix ? `${prefix}.${key}` : key;
      const hasExpected = key in expected;
      const hasActual = key in actual;

      if (hasExpected && !hasActual) {
        entries.push({ path, type: "missing", expected: expected[key], actual: undefined });
      } else if (!hasExpected && hasActual) {
        entries.push({ path, type: "extra", expected: undefined, actual: actual[key] });
      } else {
        const expVal = expected[key];
        const actVal = actual[key];

        if (this._isPlainObject(expVal) && this._isPlainObject(actVal)) {
          this._diffObjects(
            expVal as Record<string, unknown>,
            actVal as Record<string, unknown>,
            path,
            entries,
          );
        } else if (Array.isArray(expVal) && Array.isArray(actVal)) {
          if (!this._arraysEqual(expVal, actVal)) {
            entries.push({ path, type: "changed", expected: expVal, actual: actVal });
          }
        } else if (typeof expVal !== typeof actVal) {
          entries.push({ path, type: "type_mismatch", expected: expVal, actual: actVal });
        } else if (expVal !== actVal) {
          entries.push({ path, type: "changed", expected: expVal, actual: actVal });
        }
      }
    }
  }

  private _isPlainObject(val: unknown): boolean {
    return val !== null && typeof val === "object" && !Array.isArray(val);
  }

  private _arraysEqual(a: unknown[], b: unknown[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
}
