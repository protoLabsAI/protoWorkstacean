/**
 * Domain discovery — loads domain and action configs from two sources:
 *
 *   1. workspace/domains.yaml          — global domains (external app integrations)
 *   2. {projectPath}/workspace/domains.yaml — per-project domains
 *   3. {projectPath}/workspace/actions.yaml — per-project actions
 *
 * URL and header values support ${ENV_VAR} interpolation so YAML files can
 * avoid hardcoding hostnames or secrets:
 *
 *   url: ${AVA_BASE_URL}/api/world/board   →  http://ava:3008/api/world/board
 *
 * NOTE: Discovery runs once at startup. Restart workstacean to pick up changes.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveEnvVars } from "../utils/env-interpolation.ts";
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

/** Resolve ${ENV_VAR} in all header values. */
function resolveHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k, resolveEnvVars(v, "domain-discovery")]),
  );
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

  // ── Load global workspace/domains.yaml (external app integrations) ─────────
  const workspaceDir = dirname(projectsYamlPath);
  _loadDomainsYaml(join(workspaceDir, "domains.yaml"), "global", engine, result);

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

  // Deduplicate by projectPath
  const seen = new Set<string>();

  for (const project of projects) {
    if (!project.projectPath) continue;
    const projectPath = resolve(project.projectPath);
    if (seen.has(projectPath)) continue;
    seen.add(projectPath);

    const slug = project.slug ?? projectPath;

    // Load per-project domains
    _loadDomainsYaml(join(projectPath, "workspace", "domains.yaml"), slug, engine, result);

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

// ── Shared domain loader ──────────────────────────────────────────────────────

function _loadDomainsYaml(
  path: string,
  label: string,
  engine: WorldStateEngine,
  result: DiscoveryResult,
): void {
  if (!existsSync(path)) return;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = parseYaml(raw) as DomainsYaml;
    let count = 0;
    for (const domain of parsed.domains ?? []) {
      if (!domain.name || !domain.url) {
        result.errors.push(`[${label}] Invalid domain entry (missing name or url)`);
        continue;
      }
      const resolvedUrl = resolveEnvVars(domain.url, "domain-discovery");
      const collector = createHttpCollector(resolvedUrl, {
        timeoutMs: domain.timeoutMs,
        headers: resolveHeaders(domain.headers),
      });
      engine.registerDomain(domain.name, collector, domain.tickMs ?? 60_000);
      result.domainsRegistered.push(domain.name);
      count++;
    }
    if (count > 0) console.log(`[domain-discovery] ${label}: registered ${count} domain(s)`);
  } catch (err) {
    result.errors.push(`[${label}] Failed to load domains.yaml: ${(err as Error).message}`);
  }
}
