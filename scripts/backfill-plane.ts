#!/usr/bin/env bun
/**
 * backfill-plane.ts — Create Plane projects for all workspace projects missing
 * a planeProjectId, then seed standard states and labels.
 *
 * Standard states: Todo, In Progress, In Review, Done, Cancelled
 * Standard labels: bug, feature, chore
 *
 * Idempotent — safe to re-run. Skips projects that already have a planeProjectId.
 * State/label creation is also idempotent: existing items are left unchanged.
 *
 * Usage:
 *   bun scripts/backfill-plane.ts [--dry-run]
 *
 * Env vars:
 *   PLANE_API_KEY          — required
 *   PLANE_BASE_URL         — default: http://ava:3002
 *   PLANE_WORKSPACE_SLUG   — default: protolabsai
 *   PROJECTS_YAML_PATH     — default: workspace/projects.yaml (relative to cwd)
 */

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { PlaneClient } from "../lib/plane-client.ts";

// ── Config ────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const API_KEY = process.env.PLANE_API_KEY;
const BASE_URL = process.env.PLANE_BASE_URL ?? "http://ava:3002";
const WORKSPACE_SLUG = process.env.PLANE_WORKSPACE_SLUG ?? "protolabsai";
const PROJECTS_YAML = resolve(
  process.env.PROJECTS_YAML_PATH ?? join(process.cwd(), "workspace/projects.yaml"),
);

// ── Standard states & labels ──────────────────────────────────────────────────

interface StateSpec {
  name: string;
  color: string;
  group: "backlog" | "unstarted" | "started" | "completed" | "cancelled";
  isDefault?: boolean;
}

const STANDARD_STATES: StateSpec[] = [
  { name: "Todo",        color: "#e2e8f0", group: "unstarted",  isDefault: true },
  { name: "In Progress", color: "#3b82f6", group: "started" },
  { name: "In Review",   color: "#f59e0b", group: "started" },
  { name: "Done",        color: "#22c55e", group: "completed" },
  { name: "Cancelled",   color: "#ef4444", group: "cancelled" },
];

interface LabelSpec {
  name: string;
  color: string;
}

const STANDARD_LABELS: LabelSpec[] = [
  { name: "bug",     color: "#ef4444" },
  { name: "feature", color: "#3b82f6" },
  { name: "chore",   color: "#8b5cf6" },
];

// ── Plane REST helpers ────────────────────────────────────────────────────────

function headers(apiKey: string): Record<string, string> {
  return { "X-Api-Key": apiKey, "Content-Type": "application/json" };
}

async function listStates(
  baseUrl: string,
  workspaceSlug: string,
  projectId: string,
  apiKey: string,
): Promise<{ id: string; name: string }[]> {
  const resp = await fetch(
    `${baseUrl}/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/states/`,
    { headers: headers(apiKey), signal: AbortSignal.timeout(10_000) },
  );
  if (!resp.ok) return [];
  const data = (await resp.json()) as { results?: { id: string; name: string }[] };
  return data.results ?? [];
}

async function createState(
  baseUrl: string,
  workspaceSlug: string,
  projectId: string,
  apiKey: string,
  spec: StateSpec,
): Promise<boolean> {
  const resp = await fetch(
    `${baseUrl}/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/states/`,
    {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ name: spec.name, color: spec.color, group: spec.group }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  return resp.ok;
}

async function listLabels(
  baseUrl: string,
  workspaceSlug: string,
  projectId: string,
  apiKey: string,
): Promise<{ id: string; name: string }[]> {
  const resp = await fetch(
    `${baseUrl}/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/labels/`,
    { headers: headers(apiKey), signal: AbortSignal.timeout(10_000) },
  );
  if (!resp.ok) return [];
  const data = (await resp.json()) as { results?: { id: string; name: string }[] };
  return data.results ?? [];
}

async function createLabel(
  baseUrl: string,
  workspaceSlug: string,
  projectId: string,
  apiKey: string,
  spec: LabelSpec,
): Promise<boolean> {
  const resp = await fetch(
    `${baseUrl}/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/labels/`,
    {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ name: spec.name, color: spec.color }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  return resp.ok;
}

// ── Seed states for a project (idempotent) ────────────────────────────────────

async function seedStates(
  baseUrl: string,
  workspaceSlug: string,
  projectId: string,
  apiKey: string,
): Promise<{ created: string[]; skipped: string[] }> {
  const existing = await listStates(baseUrl, workspaceSlug, projectId, apiKey);
  const existingNames = new Set(existing.map(s => s.name.toLowerCase()));

  const created: string[] = [];
  const skipped: string[] = [];

  for (const spec of STANDARD_STATES) {
    if (existingNames.has(spec.name.toLowerCase())) {
      skipped.push(spec.name);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  [dry-run] Would create state: ${spec.name} (${spec.group})`);
      created.push(spec.name);
      continue;
    }
    const ok = await createState(baseUrl, workspaceSlug, projectId, apiKey, spec);
    if (ok) {
      created.push(spec.name);
    } else {
      console.warn(`  ⚠ Failed to create state: ${spec.name}`);
    }
  }

  return { created, skipped };
}

// ── Seed labels for a project (idempotent) ────────────────────────────────────

async function seedLabels(
  baseUrl: string,
  workspaceSlug: string,
  projectId: string,
  apiKey: string,
): Promise<{ created: string[]; skipped: string[] }> {
  const existing = await listLabels(baseUrl, workspaceSlug, projectId, apiKey);
  const existingNames = new Set(existing.map(l => l.name.toLowerCase()));

  const created: string[] = [];
  const skipped: string[] = [];

  for (const spec of STANDARD_LABELS) {
    if (existingNames.has(spec.name.toLowerCase())) {
      skipped.push(spec.name);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  [dry-run] Would create label: ${spec.name}`);
      created.push(spec.name);
      continue;
    }
    const ok = await createLabel(baseUrl, workspaceSlug, projectId, apiKey, spec);
    if (ok) {
      created.push(spec.name);
    } else {
      console.warn(`  ⚠ Failed to create label: ${spec.name}`);
    }
  }

  return { created, skipped };
}

// ── projects.yaml helpers ─────────────────────────────────────────────────────

interface ProjectRecord {
  slug: string;
  title?: string;
  github?: string;
  planeProjectId?: string;
  [key: string]: unknown;
}

interface ProjectsYamlFile {
  projects: ProjectRecord[];
}

function loadProjectsYaml(path: string): ProjectsYamlFile {
  if (!existsSync(path)) {
    throw new Error(`projects.yaml not found at: ${path}`);
  }
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw) as ProjectsYamlFile;
  return { projects: parsed.projects ?? [] };
}

function saveProjectsYaml(path: string, data: ProjectsYamlFile, originalContent: string): void {
  const headerMatch = originalContent.match(/^(#[^\n]*\n)*/);
  const header = headerMatch ? headerMatch[0] : "";
  writeFileSync(path, header + stringifyYaml({ projects: data.projects }, { lineWidth: 120 }), "utf8");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!API_KEY) {
    console.error("Error: PLANE_API_KEY environment variable is required.");
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log("=== DRY RUN MODE — no changes will be written ===\n");
  }

  console.log(`Loading projects from: ${PROJECTS_YAML}`);
  const originalContent = existsSync(PROJECTS_YAML) ? readFileSync(PROJECTS_YAML, "utf8") : "";
  const yamlData = loadProjectsYaml(PROJECTS_YAML);
  const { projects } = yamlData;

  const missing = projects.filter(p => !p.planeProjectId);
  const alreadyLinked = projects.filter(p => p.planeProjectId);

  console.log(`Found ${projects.length} total project(s), ${missing.length} missing planeProjectId, ${alreadyLinked.length} already linked.\n`);

  if (missing.length === 0) {
    console.log("All projects already have a planeProjectId — nothing to do.");
    return;
  }

  const client = new PlaneClient(BASE_URL, WORKSPACE_SLUG, API_KEY);
  let updatedCount = 0;

  for (const project of missing) {
    const slug = project.slug;
    const title = project.title ?? slug;
    const github = project.github ?? "";

    console.log(`\nProcessing: ${slug} (${github || "no github"})`);

    // Derive Plane identifier (max 12 chars, uppercase, alphanumeric)
    const identifier = slug
      .replace(/[^a-zA-Z0-9]/g, "")
      .slice(0, 12)
      .toUpperCase() || "PROJECT";

    let planeProjectId: string | null = null;

    if (DRY_RUN) {
      console.log(`  [dry-run] Would create Plane project "${title}" (identifier: ${identifier})`);
      planeProjectId = `dry-run-${slug}`;
    } else {
      const planeProject = await client.createProject(
        title,
        identifier,
        github ? `GitHub: ${github}` : undefined,
      );

      if (!planeProject) {
        console.error(`  ✗ Failed to create Plane project for "${slug}" — skipping`);
        continue;
      }

      planeProjectId = planeProject.id;
      console.log(`  ✓ Plane project: ${planeProject.name} (${planeProject.id})`);
    }

    // Seed standard states
    const stateResult = await seedStates(BASE_URL, WORKSPACE_SLUG, planeProjectId, API_KEY);
    if (stateResult.created.length > 0) {
      console.log(`  ✓ States created: ${stateResult.created.join(", ")}`);
    }
    if (stateResult.skipped.length > 0) {
      console.log(`  ↷ States already exist: ${stateResult.skipped.join(", ")}`);
    }

    // Seed standard labels
    const labelResult = await seedLabels(BASE_URL, WORKSPACE_SLUG, planeProjectId, API_KEY);
    if (labelResult.created.length > 0) {
      console.log(`  ✓ Labels created: ${labelResult.created.join(", ")}`);
    }
    if (labelResult.skipped.length > 0) {
      console.log(`  ↷ Labels already exist: ${labelResult.skipped.join(", ")}`);
    }

    // Update projects.yaml in memory
    if (!DRY_RUN) {
      project.planeProjectId = planeProjectId;
      updatedCount++;
    } else {
      console.log(`  [dry-run] Would write planeProjectId: ${planeProjectId}`);
    }
  }

  // Write updated projects.yaml
  if (!DRY_RUN && updatedCount > 0) {
    saveProjectsYaml(PROJECTS_YAML, yamlData, originalContent);
    console.log(`\n✓ Updated ${updatedCount} project(s) in projects.yaml`);
  } else if (DRY_RUN) {
    console.log(`\n[dry-run] Would update ${missing.length} project(s) in projects.yaml`);
  }

  console.log("\nBackfill complete.");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
