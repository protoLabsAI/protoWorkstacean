/**
 * Bus-state boundary.
 *
 * The A2A 1.0 SDK speaks the `TaskState` enum (SCREAMING_SNAKE:
 * `TASK_STATE_WORKING`, `TASK_STATE_COMPLETED`, …). protoLabs' internal event
 * bus speaks lowercase state strings (`"working"`, `"completed"`, …). This
 * module is the single mapper between the two, so the SDK enum stays contained
 * to the A2A edge and never leaks onto the bus contract.
 *
 * This boundary is TypeScript-only — the Python agents are A2A *peers*, so they
 * emit the SDK enum on the wire and never touch the bus string form.
 */

import { TaskState } from "@a2a-js/sdk";

/** Terminal A2A task states (1.0 SCREAMING_SNAKE enum). */
export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

/** True when the state is terminal (the task has stopped progressing). */
export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/** True when the terminal state represents a failure (failed or rejected). */
export function isErrorState(state: TaskState): boolean {
  return state === TaskState.TASK_STATE_FAILED || state === TaskState.TASK_STATE_REJECTED;
}

/**
 * Map the A2A 1.0 `TaskState` enum to the lowercase state strings the bus
 * speaks. This keeps the enum contained to the A2A edge: the bus contract
 * (`SkillResult.data.taskState`, `WORKING_STATES`, `TaskTracker`) stays
 * string-typed.
 */
export function stateToLegacyString(state: TaskState): string {
  switch (state) {
    case TaskState.TASK_STATE_SUBMITTED: return "submitted";
    case TaskState.TASK_STATE_WORKING: return "working";
    case TaskState.TASK_STATE_COMPLETED: return "completed";
    case TaskState.TASK_STATE_FAILED: return "failed";
    case TaskState.TASK_STATE_CANCELED: return "canceled";
    case TaskState.TASK_STATE_REJECTED: return "rejected";
    case TaskState.TASK_STATE_INPUT_REQUIRED: return "input-required";
    case TaskState.TASK_STATE_AUTH_REQUIRED: return "auth-required";
    default: return "unknown";
  }
}
