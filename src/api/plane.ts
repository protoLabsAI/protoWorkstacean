/**
 * Plane API routes — exposes Plane workspace state as world state domains.
 *
 * Currently serves a single endpoint:
 *   GET /api/plane-board — aggregated open-issue view across every project
 *                          in workspace/projects.yaml that carries a
 *                          planeProjectId field.
 *
 * Polled by the WorldStateEngine on a 2-minute cadence (matching the
 * pr_pipeline domain). The resulting `plane` domain lets goals react to
 * Plane state the same way they already react to CI, PRs, drift, etc.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Route, ApiContext } from "./types.ts";
import { PlaneClient } from "../../lib/plane-client.ts";

interface ProjectMeta {
  slug: string;
  title?: string;
  planeProjectId: string;
}

/** Open-issue summary for a single Plane project. */
interface PlaneProjectSummary {
  slug: string;
  planeProjectId: string;
  totalOpen: number;
  urgent: number;
  high: number;
  medium: number;
  low: number;
  none: number;
  unassigned: number;
  stale: number; // open > STALE_THRESHOLD_MS old
  oldestOpenAgeMs: number;
}

/** Roll-up across all projects — what goals will selector into. */
interface PlaneBoardSummary {
  totalOpen: number;
  urgentOpen: number;
  unassignedOpen: number;
  staleOpen: number;
  oldestOpenAgeMs: number;
  projects: PlaneProjectSummary[];
}

const STALE_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days — beyond this, an open issue is "stale"

function loadPlaneProjects(workspaceDir: string): ProjectMeta[] {
  const path = join(workspaceDir, "projects.yaml");
  if (!existsSync(path)) return [];
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as {
      projects?: Array<{ slug?: string; title?: string; planeProjectId?: string; status?: string }>;
    };
    const out: ProjectMeta[] = [];
    for (const p of parsed.projects ?? []) {
      if (!p.slug || !p.planeProjectId) continue;
      if (p.status === "archived" || p.status === "suspended") continue;
      out.push({ slug: p.slug, title: p.title, planeProjectId: p.planeProjectId });
    }
    return out;
  } catch {
    return [];
  }
}

const EMPTY_BOARD: PlaneBoardSummary = {
  totalOpen: 0,
  urgentOpen: 0,
  unassignedOpen: 0,
  staleOpen: 0,
  oldestOpenAgeMs: 0,
  projects: [],
};

export function createRoutes(ctx: ApiContext): Route[] {
  const baseUrl = process.env.PLANE_BASE_URL ?? "http://ava:3002";
  const workspaceSlug = process.env.PLANE_WORKSPACE_SLUG ?? "protolabsai";
  const apiKey = process.env.PLANE_API_KEY ?? "";

  async function handleGetPlaneBoard(): Promise<Response> {
    if (!apiKey) return Response.json(EMPTY_BOARD);

    const projects = loadPlaneProjects(ctx.workspaceDir);
    if (projects.length === 0) return Response.json(EMPTY_BOARD);

    const client = new PlaneClient(baseUrl, workspaceSlug, apiKey);
    const now = Date.now();
    const perProject: PlaneProjectSummary[] = [];

    for (const proj of projects) {
      try {
        // Resolve state groups so we can filter to "not completed / not cancelled"
        const stateGroups = await client.fetchStateGroups(proj.planeProjectId);
        const closedStates = new Set<string>();
        for (const [uuid, group] of stateGroups) {
          if (group === "completed" || group === "cancelled") closedStates.add(uuid);
        }

        const issues = await client.listIssues(proj.planeProjectId, { maxIssues: 500 });
        const openIssues = issues.filter(i => {
          if (i.state__group === "completed" || i.state__group === "cancelled") return false;
          if (closedStates.has(i.state)) return false;
          return true;
        });

        const summary: PlaneProjectSummary = {
          slug: proj.slug,
          planeProjectId: proj.planeProjectId,
          totalOpen: openIssues.length,
          urgent: 0,
          high: 0,
          medium: 0,
          low: 0,
          none: 0,
          unassigned: 0,
          stale: 0,
          oldestOpenAgeMs: 0,
        };

        for (const i of openIssues) {
          const prio = (i.priority ?? "none") as string;
          if (prio === "urgent") summary.urgent += 1;
          else if (prio === "high") summary.high += 1;
          else if (prio === "medium") summary.medium += 1;
          else if (prio === "low") summary.low += 1;
          else summary.none += 1;

          if (!i.assignees || i.assignees.length === 0) summary.unassigned += 1;

          if (i.created_at) {
            const ageMs = now - new Date(i.created_at).getTime();
            if (ageMs > STALE_THRESHOLD_MS) summary.stale += 1;
            if (ageMs > summary.oldestOpenAgeMs) summary.oldestOpenAgeMs = ageMs;
          }
        }

        perProject.push(summary);
      } catch (err) {
        console.warn(`[plane-board] Failed to aggregate ${proj.slug}:`, err instanceof Error ? err.message : err);
        perProject.push({
          slug: proj.slug,
          planeProjectId: proj.planeProjectId,
          totalOpen: 0, urgent: 0, high: 0, medium: 0, low: 0, none: 0,
          unassigned: 0, stale: 0, oldestOpenAgeMs: 0,
        });
      }
    }

    const rollup: PlaneBoardSummary = {
      totalOpen: perProject.reduce((a, p) => a + p.totalOpen, 0),
      urgentOpen: perProject.reduce((a, p) => a + p.urgent, 0),
      unassignedOpen: perProject.reduce((a, p) => a + p.unassigned, 0),
      staleOpen: perProject.reduce((a, p) => a + p.stale, 0),
      oldestOpenAgeMs: Math.max(0, ...perProject.map(p => p.oldestOpenAgeMs)),
      projects: perProject,
    };

    return Response.json(rollup);
  }

  return [
    { method: "GET", path: "/api/plane-board", handler: () => handleGetPlaneBoard() },
  ];
}
