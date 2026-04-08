/**
 * HTN hierarchy level definitions.
 *
 * The hierarchy has four levels:
 * - portfolio: highest-level strategic tasks (e.g., "improve project health")
 * - project: project-scoped tasks (e.g., "fix CI pipeline")
 * - domain: domain-specific tasks (e.g., "restart failing service")
 * - action: primitive executable actions (e.g., "set service.status = healthy")
 */

import type { HierarchyLevel } from "./types.ts";
import { HIERARCHY_ORDER } from "./types.ts";

/** Get the next level down in the hierarchy. Returns null at bottom level. */
export function childLevel(level: HierarchyLevel): HierarchyLevel | null {
  const idx = HIERARCHY_ORDER.indexOf(level);
  if (idx === -1 || idx >= HIERARCHY_ORDER.length - 1) return null;
  return HIERARCHY_ORDER[idx + 1];
}

/** Get the next level up in the hierarchy. Returns null at top level. */
export function parentLevel(level: HierarchyLevel): HierarchyLevel | null {
  const idx = HIERARCHY_ORDER.indexOf(level);
  if (idx <= 0) return null;
  return HIERARCHY_ORDER[idx - 1];
}

/** Check if a level is the bottom (primitive action) level. */
export function isPrimitiveLevel(level: HierarchyLevel): boolean {
  return level === "action";
}

/** Check if a level is the top (portfolio) level. */
export function isTopLevel(level: HierarchyLevel): boolean {
  return level === "portfolio";
}

/** Get the depth of a level (0 = portfolio, 3 = action). */
export function levelDepth(level: HierarchyLevel): number {
  return HIERARCHY_ORDER.indexOf(level);
}
