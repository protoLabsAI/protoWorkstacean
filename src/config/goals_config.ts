export interface GoalsConfig {
  /** When true, evaluator only observes and logs — no planner actions triggered */
  observeOnly: boolean;
  /** Workspace directory for finding goals.yaml */
  workspaceDir: string;
  /** Base directory for per-project goals.yaml overrides */
  projectsBaseDir?: string;
  /** Evaluation interval in milliseconds (0 = event-driven only) */
  evaluationIntervalMs?: number;
}

export const DEFAULT_GOALS_CONFIG: GoalsConfig = {
  observeOnly: true,
  workspaceDir: "workspace",
  evaluationIntervalMs: 0,
};
