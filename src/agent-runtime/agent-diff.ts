/**
 * Agent-definition diffing for hot-reload (ADR-0004, P1).
 *
 * The WorkspaceWatcher reports which files changed; this maps a freshly-loaded
 * set of AgentDefinitions against the currently-registered set (by name +
 * content hash) into added / changed / removed. Pure + synchronous so it's
 * unit-testable and reused by both the detect-only (P1 day 1) and apply
 * (P1 day 2) paths.
 */

import { createHash } from "node:crypto";
import type { AgentDefinition } from "./types.ts";

/** Stable content hash of a definition — changes iff anything that affects the executor changes. */
export function hashDefinition(def: AgentDefinition): string {
  return createHash("sha256").update(JSON.stringify(def)).digest("hex").slice(0, 16);
}

export interface AgentDiff {
  /** Agents present now but not before. */
  added: AgentDefinition[];
  /** Agents present before and now, with a changed content hash. */
  changed: AgentDefinition[];
  /** Names of agents present before but gone now. */
  removed: string[];
}

export function isEmptyAgentDiff(d: AgentDiff): boolean {
  return d.added.length === 0 && d.changed.length === 0 && d.removed.length === 0;
}

/**
 * Diff a freshly-loaded definition set against the registered (name → hash) map.
 * `next` may contain duplicate names (two files declaring the same agent) — the
 * last one wins, matching how a Map-based registry would resolve them.
 */
export function computeAgentDiff(
  registered: ReadonlyMap<string, string>,
  next: AgentDefinition[],
): AgentDiff {
  const added: AgentDefinition[] = [];
  const changed: AgentDefinition[] = [];
  const nextByName = new Map<string, AgentDefinition>();
  for (const def of next) nextByName.set(def.name, def); // last-wins on dup names

  for (const [name, def] of nextByName) {
    const prevHash = registered.get(name);
    const nextHash = hashDefinition(def);
    if (prevHash === undefined) added.push(def);
    else if (prevHash !== nextHash) changed.push(def);
  }

  const removed: string[] = [];
  for (const name of registered.keys()) {
    if (!nextByName.has(name)) removed.push(name);
  }

  return { added, changed, removed };
}
