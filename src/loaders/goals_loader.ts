import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Goal, GoalsFile, LoadedGoals } from "../types/goals.ts";

export class GoalsLoader {
  private workspaceDir: string;
  private projectsBaseDir: string;

  constructor(workspaceDir: string, projectsBaseDir?: string) {
    this.workspaceDir = resolve(workspaceDir);
    this.projectsBaseDir = projectsBaseDir
      ? resolve(projectsBaseDir)
      : join(resolve(workspaceDir), "..", ".proto", "projects");
  }

  /** Load global goals from workspace/goals.yaml */
  loadGlobal(): Goal[] {
    const goalsPath = join(this.workspaceDir, "goals.yaml");
    if (!existsSync(goalsPath)) {
      console.info("[goals-loader] No global goals.yaml found at", goalsPath);
      return [];
    }
    return this._parseGoalsFile(goalsPath, "global");
  }

  /** Load per-project goals from .proto/projects/{slug}/goals.yaml */
  loadProject(projectSlug: string): Goal[] {
    const goalsPath = join(this.projectsBaseDir, projectSlug, "goals.yaml");
    if (!existsSync(goalsPath)) {
      console.info(`[goals-loader] No project goals.yaml for "${projectSlug}" at`, goalsPath);
      return [];
    }
    return this._parseGoalsFile(goalsPath, `project:${projectSlug}`);
  }

  /**
   * Load and merge global + per-project goals.
   * Project goals with the same ID override global goals.
   */
  loadMerged(projectSlug?: string): LoadedGoals {
    const globalGoals = this.loadGlobal();

    if (!projectSlug) {
      return { goals: globalGoals, source: "global" };
    }

    const projectGoals = this.loadProject(projectSlug);

    if (projectGoals.length === 0) {
      return { goals: globalGoals, source: "global", projectSlug };
    }

    const merged = new Map<string, Goal>();
    for (const goal of globalGoals) {
      merged.set(goal.id, goal);
    }
    for (const goal of projectGoals) {
      merged.set(goal.id, goal); // project overrides global for same ID
    }

    return {
      goals: Array.from(merged.values()),
      source: "merged",
      projectSlug,
    };
  }

  private _parseGoalsFile(filePath: string, source: string): Goal[] {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = parseYaml(raw) as GoalsFile;

      if (!parsed || !Array.isArray(parsed.goals)) {
        console.warn(`[goals-loader] Invalid goals.yaml at ${filePath}: missing "goals" array`);
        return [];
      }

      const validGoals: Goal[] = [];
      for (const goal of parsed.goals) {
        const validated = this._validateGoal(goal);
        if (validated) {
          validGoals.push(validated);
        } else {
          console.warn(`[goals-loader] Skipping invalid goal in ${source}:`, goal);
        }
      }

      return validGoals;
    } catch (err) {
      console.error(`[goals-loader] Failed to parse goals.yaml at ${filePath}:`, err);
      return [];
    }
  }

  private _validateGoal(raw: unknown): Goal | null {
    if (!raw || typeof raw !== "object") return null;
    const g = raw as Record<string, unknown>;

    if (typeof g.id !== "string" || !g.id) {
      console.warn("[goals-loader] Schema validation error: goal missing required 'id' field", g);
      return null;
    }
    if (!["Invariant", "Threshold", "Distribution"].includes(g.type as string)) {
      console.warn(`[goals-loader] Schema validation error: unknown goal type "${g.type}" for goal "${g.id}"`);
      return null;
    }
    if (typeof g.description !== "string") {
      console.warn(`[goals-loader] Schema validation error: goal "${g.id}" missing description`);
      return null;
    }

    return g as unknown as Goal;
  }
}
