export type DiffType = "missing" | "changed" | "extra" | "type_mismatch";

export interface StateDiffEntry {
  path: string;
  type: DiffType;
  expected: unknown;
  actual: unknown;
}

export interface StateDiff {
  entries: StateDiffEntry[];
  hasChanges: boolean;
}

export type WorldState = Record<string, unknown>;
