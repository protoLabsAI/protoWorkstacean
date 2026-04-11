/**
 * Task network — stores composite and primitive tasks for HTN decomposition.
 *
 * A task network maps task IDs to either:
 * - CompositeTask: decomposes into sub-tasks
 * - Action: primitive executable action
 */

import type { Action, CompositeTask, HierarchyLevel, PlannerState } from "./types.ts";

/** A task in the network can be composite or primitive. */
export type TaskEntry =
  | { type: "composite"; task: CompositeTask }
  | { type: "primitive"; action: Action };

export class TaskNetwork {
  private tasks = new Map<string, TaskEntry>();

  /** Register a composite task. */
  addCompositeTask(task: CompositeTask): void {
    this.tasks.set(task.id, { type: "composite", task });
  }

  /** Register a primitive action. */
  addPrimitiveAction(action: Action): void {
    this.tasks.set(action.id, { type: "primitive", action });
  }

  /** Look up a task by ID. */
  getTask(id: string): TaskEntry | undefined {
    return this.tasks.get(id);
  }

  /** Get all tasks at a specific hierarchy level. */
  getTasksAtLevel(level: HierarchyLevel): TaskEntry[] {
    const result: TaskEntry[] = [];
    for (const entry of this.tasks.values()) {
      if (entry.type === "composite" && entry.task.level === level) {
        result.push(entry);
      } else if (entry.type === "primitive" && entry.action.level === level) {
        result.push(entry);
      }
    }
    return result;
  }

  /** Get all composite tasks. */
  getCompositeTasks(): CompositeTask[] {
    const result: CompositeTask[] = [];
    for (const entry of this.tasks.values()) {
      if (entry.type === "composite") result.push(entry.task);
    }
    return result;
  }

  /** Get all primitive actions. */
  getPrimitiveActions(): Action[] {
    const result: Action[] = [];
    for (const entry of this.tasks.values()) {
      if (entry.type === "primitive") result.push(entry.action);
    }
    return result;
  }

  /**
   * Recursively decompose a task ID into primitive actions.
   * Returns null if decomposition fails (e.g., unknown task ID, precondition not met).
   */
  decompose(taskId: string, state: PlannerState): Action[] | null {
    const entry = this.tasks.get(taskId);
    if (!entry) return null;

    if (entry.type === "primitive") {
      return [entry.action];
    }

    const composite = entry.task;

    // Check precondition if present
    if (composite.precondition && !composite.precondition(state)) {
      return null;
    }

    const subItems = composite.decompose(state);
    const result: Action[] = [];

    for (const item of subItems) {
      if (typeof item === "string") {
        // Sub-task ID — recurse
        const subActions = this.decompose(item, state);
        if (subActions === null) return null;
        result.push(...subActions);
      } else {
        // Inline primitive action
        result.push(item);
      }
    }

    return result;
  }

  /** Get the number of tasks in the network. */
  get size(): number {
    return this.tasks.size;
  }
}
