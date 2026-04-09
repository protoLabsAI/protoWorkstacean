/**
 * Domain discovery — reads projects.yaml and loads per-project domain/goal/action configs.
 *
 * For each project entry that has a projectPath, this module looks for:
 *   {projectPath}/workspace/domains.yaml   — HTTP domain registrations
 *   {projectPath}/workspace/actions.yaml   — action definitions
 *
 * Domain URLs support ${ENV_VAR} interpolation so that domains.yaml files can
 * avoid hardcoding hostnames:
 *
 *   url: ${AVA_BASE_URL}/api/world/board   →  http://ava:3008/api/world/board
 *
 * NOTE: Discovery runs once at startup. Restart workstacean to pick up projects
 * added via onboard_project or manually edited projects.yaml entries.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { WorldStateEngine } from "../../lib/plugins/world-state-engine.ts";
import { createHttpCollector } from "../../lib/plugins/world-state-engine.ts";
import type { ActionRegistry } from "../planner/action-registry.ts";
import type { Action } from "../planner/types/action.ts";

// ── domains.yaml schema ───────────────────────────────────────────────────────

interface DomainConfig {
  name: string;
  url: string;
  tickMs: number;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

interface DomainsYaml {
  domains?: DomainConfig[];
}

// ── actions.yaml schema ───────────────────────────────────────────────────────

interface RawAction {
  id: string;
  name?: string;
  description?: string;
  goalId?: string;
  tier?: string;
  priority?: number;
  cost?: number;
  preconditions?: Array<{ path: string; operator: string; value?: unknown }>;
  effects?: Array<{ path: string; op?: string; operation?: string; value?: unknown }>;
  meta?: Record<string, unknown>;
}

interface ActionsYaml {
  actions?: RawAction[];
}

// ── Project entry from projects.yaml ─────────────────────────────────────────

interface ProjectEntry {
  slug?: string;
  projectPath?: string;
  [key: string]: unknown;
}

interface ProjectsYaml {
  projects?: ProjectEntry[];
}

// ── Discovery ─────────────────────────────────────────────────────────────────

export interface DiscoveryResult {
  domainsRegistered: string[];
  actionsLoaded: number;
  errors: string[];
}

/**
 * Interpolate ${ENV_VAR} placeholders in a URL string.
 * Unresolved variables are left as-is and a console.warn is emitted.
 */
function resolveUrl(url: string): string {
  return url.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
    const val = process.env[name];
    if (val === undefined) {
      console.warn(`[domain-discovery] Unresolved env var in URL: \${${name}} — set ${name} in your environment`);
      return match; // leave unresolved so the error surfaces at poll time, not silently
    }
    return val;
  });
}

/**
 * Discover and register domains + actions from all projects in projects.yaml.
 */
export function discoverAndRegister(
  projectsYamlPath: string,
  engine: WorldStateEngine,
  actionRegistry: ActionRegistry,
): DiscoveryResult {
  const result: DiscoveryResult = { domainsRegistered: [], actionsLoaded: 0, errors: [] };

  if (!existsSync(projectsYamlPath)) {
    return result;
  }

  let projects: ProjectEntry[];
  try {
    const raw = readFileSync(projectsYamlPath, "utf8");
    const parsed = parseYaml(raw) as ProjectsYaml;
    projects = parsed.projects ?? [];
  } catch (err) {
    result.errors.push(`Failed to parse projects.yaml: ${(err as Error).message}`);
    return result;
  }

  // Deduplicate by projectPath — projects.yaml can have duplicate slugs (e.g. after
  // re-onboarding). Use the first occurrence.
  const seen = new Set<string>();

  for (const project of projects) {
    if (!project.projectPath) continue;
    const projectPath = resolve(project.projectPath);
    if (seen.has(projectPath)) continue;
    seen.add(projectPath);

    const slug = project.slug ?? projectPath;

    // Load domains
    const domainsPath = join(projectPath, "workspace", "domains.yaml");
    if (existsSync(domainsPath)) {
      try {
        const raw = readFileSync(domainsPath, "utf8");
        const parsed = parseYaml(raw) as DomainsYaml;
        for (const domain of parsed.domains ?? []) {
          if (!domain.name || !domain.url || !domain.tickMs) {
            result.errors.push(`[${slug}] Invalid domain entry (missing name, url, or tickMs)`);
            continue;
          }
          const resolvedUrl = resolveUrl(domain.url);
          const collector = createHttpCollector(resolvedUrl, {
            timeoutMs: domain.timeoutMs,
            headers: domain.headers,
          });
          engine.registerDomain(domain.name, collector, domain.tickMs);
          result.domainsRegistered.push(domain.name);
        }
        console.log(`[domain-discovery] ${slug}: registered ${parsed.domains?.length ?? 0} domain(s)`);
      } catch (err) {
        result.errors.push(`[${slug}] Failed to load domains.yaml: ${(err as Error).message}`);
      }
    }

    // Load actions
    const actionsPath = join(projectPath, "workspace", "actions.yaml");
    if (existsSync(actionsPath)) {
      try {
        const raw = readFileSync(actionsPath, "utf8");
        const parsed = parseYaml(raw) as ActionsYaml;
        let loaded = 0;
        for (const a of parsed.actions ?? []) {
          if (!a.id) continue;
          try {
            // Warn on collision — last writer wins but we surface it so it's not silent.
            if (actionRegistry.get(a.id)) {
              result.errors.push(`[${slug}] Action "${a.id}" overwrites an existing registration — check for duplicate IDs across projects`);
            }
            const action: Action = {
              id: a.id,
              name: a.name ?? a.id,
              description: a.description ?? "",
              goalId: a.goalId ?? "",
              tier: (a.tier as Action["tier"]) ?? "tier_0",
              priority: typeof a.priority === "number" ? a.priority : 0,
              cost: typeof a.cost === "number" ? a.cost : 0,
              preconditions: (a.preconditions ?? []).map(p => ({
                path: p.path,
                operator: p.operator as Action["preconditions"][number]["operator"],
                value: p.value,
              })),
              effects: (a.effects ?? []).map(e => ({
                path: e.path,
                operation: ((e.operation ?? e.op) as Action["effects"][number]["operation"]),
                value: e.value,
              })),
              meta: typeof a.meta === "object" && a.meta !== null ? (a.meta as Action["meta"]) : {},
            };
            actionRegistry.upsert(action);
            loaded++;
          } catch (err) {
            result.errors.push(`[${slug}] Skipping action "${a.id}": ${(err as Error).message}`);
          }
        }
        result.actionsLoaded += loaded;
        console.log(`[domain-discovery] ${slug}: loaded ${loaded} action(s)`);
      } catch (err) {
        result.errors.push(`[${slug}] Failed to load actions.yaml: ${(err as Error).message}`);
      }
    }
  }

  return result;
}
