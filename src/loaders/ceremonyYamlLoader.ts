/**
 * CeremonyYamlLoader — scans workspace/ceremonies/ and
 * .proto/projects/{slug}/ceremonies/ for ceremony YAML files.
 *
 * Merges global and per-project ceremonies. Project-level ceremonies
 * with the same ID override global ones.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Ceremony } from "../plugins/CeremonyPlugin.types.ts";

export interface LoadedCeremonies {
  ceremonies: Ceremony[];
  source: "global" | "merged" | "project";
  projectSlug?: string;
}

export class CeremonyYamlLoader {
  private workspaceDir: string;
  private projectsBaseDir: string;

  constructor(workspaceDir: string, projectsBaseDir?: string) {
    this.workspaceDir = resolve(workspaceDir);
    this.projectsBaseDir = projectsBaseDir
      ? resolve(projectsBaseDir)
      : join(resolve(workspaceDir), "..", ".proto", "projects");
  }

  /** Load global ceremonies from workspace/ceremonies/ */
  loadGlobal(): Ceremony[] {
    const ceremoniesDir = join(this.workspaceDir, "ceremonies");
    return this._loadFromDir(ceremoniesDir, "global");
  }

  /** Load per-project ceremonies from .proto/projects/{slug}/ceremonies/ */
  loadProject(projectSlug: string): Ceremony[] {
    const ceremoniesDir = join(this.projectsBaseDir, projectSlug, "ceremonies");
    return this._loadFromDir(ceremoniesDir, `project:${projectSlug}`);
  }

  /**
   * Load and merge global + per-project ceremonies.
   * Project ceremonies with the same ID override global ones.
   */
  loadMerged(projectSlug?: string): LoadedCeremonies {
    const globalCeremonies = this.loadGlobal();

    if (!projectSlug) {
      return { ceremonies: globalCeremonies, source: "global" };
    }

    const projectCeremonies = this.loadProject(projectSlug);

    if (projectCeremonies.length === 0) {
      return { ceremonies: globalCeremonies, source: "global", projectSlug };
    }

    const merged = new Map<string, Ceremony>();
    for (const ceremony of globalCeremonies) {
      merged.set(ceremony.id, ceremony);
    }
    for (const ceremony of projectCeremonies) {
      merged.set(ceremony.id, ceremony); // project overrides global for same ID
    }

    return {
      ceremonies: Array.from(merged.values()),
      source: "merged",
      projectSlug,
    };
  }

  private _loadFromDir(dir: string, source: string): Ceremony[] {
    if (!existsSync(dir)) {
      return [];
    }

    let files: string[];
    try {
      files = readdirSync(dir).filter(
        (f) => f.endsWith(".yaml") || f.endsWith(".yml")
      );
    } catch (err) {
      console.error(`[ceremony-loader] Failed to read directory ${dir}:`, err);
      return [];
    }

    const ceremonies: Ceremony[] = [];
    for (const file of files) {
      const filePath = join(dir, file);
      const ceremony = this._parseFile(filePath, source);
      if (ceremony) {
        ceremonies.push(ceremony);
      }
    }

    return ceremonies;
  }

  private _parseFile(filePath: string, source: string): Ceremony | null {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = parseYaml(raw) as unknown;
      return this._validate(parsed, source, filePath);
    } catch (err) {
      console.error(`[ceremony-loader] Failed to parse ${filePath}:`, err);
      return null;
    }
  }

  private _validate(raw: unknown, source: string, filePath: string): Ceremony | null {
    if (!raw || typeof raw !== "object") {
      console.warn(`[ceremony-loader] Invalid ceremony YAML at ${filePath}: not an object`);
      return null;
    }

    const c = raw as Record<string, unknown>;

    // Disabled ceremonies are still returned (with enabled: false). The
    // CeremonyPlugin scheduler is responsible for filtering them — at both
    // initial load and hot-reload — so a disabled entry never lands in the
    // ceremony registry and external `ceremony.<id>.execute` triggers cannot
    // resurrect it. Previously returning null here also broke hot-reload's
    // _reloadChangedCeremonies path, which couldn't see a disappearing entry.

    if (typeof c.id !== "string" || !c.id) {
      console.warn(`[ceremony-loader] Skipping ${filePath} (${source}): missing required 'id' field`);
      return null;
    }
    if (typeof c.name !== "string" || !c.name) {
      console.warn(`[ceremony-loader] Skipping ${filePath} (${source}): missing required 'name' field`);
      return null;
    }
    if (typeof c.schedule !== "string" || !c.schedule) {
      console.warn(`[ceremony-loader] Skipping ${filePath} (${source}): missing required 'schedule' field`);
      return null;
    }
    if (typeof c.skill !== "string" || !c.skill) {
      console.warn(`[ceremony-loader] Skipping ${filePath} (${source}): missing required 'skill' field`);
      return null;
    }
    if (!Array.isArray(c.targets) || c.targets.length === 0) {
      console.warn(`[ceremony-loader] Skipping ${filePath} (${source}): 'targets' must be a non-empty array`);
      return null;
    }

    return {
      id: c.id,
      name: c.name,
      schedule: c.schedule,
      skill: c.skill,
      targets: c.targets as string[],
      notifyChannel: typeof c.notifyChannel === "string" ? c.notifyChannel : undefined,
      enabled: c.enabled !== false,
      timeoutMs: typeof c.timeoutMs === "number" && c.timeoutMs > 0 ? c.timeoutMs : undefined,
    };
  }
}
