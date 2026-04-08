/**
 * CeremonyPlugin type definitions.
 *
 * Ceremonies are YAML-defined recurring fleet rituals that replace hardcoded cron tasks.
 * They are configurable, observable, and hot-reloadable.
 */

export interface Ceremony {
  /** Unique ceremony identifier, e.g. "board.pr-audit" */
  id: string;
  /** Human-readable name */
  name: string;
  /** Cron expression, e.g. "0 /3 * * *" (every 3 hours) */
  schedule: string;
  /** Agent skill to invoke when ceremony fires */
  skill: string;
  /** Project paths to target, or ['all'] for all projects */
  targets: string[];
  /** Optional Discord channel slug for outcome notifications */
  notifyChannel?: string;
  /** Whether this ceremony is active */
  enabled: boolean;
}

export interface CeremonyRunContext {
  /** Unique run identifier */
  runId: string;
  /** Ceremony ID */
  ceremonyId: string;
  /** Resolved project paths for this run */
  projectPaths: string[];
  /** Unix timestamp ms when this run started */
  startedAt: number;
  /** ISO timestamp of the previous run, if any */
  lastRun?: string;
}

export interface CeremonyOutcome {
  /** Unique run identifier */
  runId: string;
  /** Ceremony ID */
  ceremonyId: string;
  /** Agent skill that was invoked */
  skill: string;
  /** Whether the ceremony completed successfully, failed, or timed out */
  status: "success" | "failure" | "timeout";
  /** Duration in milliseconds */
  duration: number;
  /** Project paths that were targeted */
  targets: string[];
  /** Unix timestamp ms when this run started */
  startedAt: number;
  /** Unix timestamp ms when this run completed */
  completedAt: number;
  /** Optional result summary from skill execution */
  result?: string;
  /** Error message if status is "failure" */
  error?: string;
}

export interface CeremoniesState {
  /** All registered ceremonies keyed by id */
  ceremonies: Record<string, Ceremony>;
  /** Execution history (most recent first, capped at 100 entries) */
  history: CeremonyOutcome[];
  /** Current status per ceremony id */
  status: Record<string, "idle" | "running" | "failed">;
  /** Last execution outcome per ceremony id */
  lastRun: Record<string, CeremonyOutcome>;
  /** Unix timestamp ms of last state update */
  updatedAt: number;
}
