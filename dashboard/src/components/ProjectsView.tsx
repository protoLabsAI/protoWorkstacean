import { useState, useEffect } from "preact/hooks";
import ProjectCard from "./ProjectCard.tsx";
import type { ProjectEntry, CiProjectData, PrData } from "./ProjectCard.tsx";
<<<<<<< HEAD

const POLL_INTERVAL_MS = 60_000;

interface ProjectsApiResponse {
  success: boolean;
  data: ProjectEntry[];
}

interface CiHealthResponse {
  successRate: number;
  totalRuns: number;
  failedRuns: number;
  projects: CiProjectData[];
}

interface PrPipelineResponse {
  totalOpen: number;
  conflicting: number;
  stale: number;
  failing: number;
  prs: PrData[];
}

export default function ProjectsView() {
  const [projects, setProjects] = useState<ProjectEntry[]>([]);
  const [ciHealth, setCiHealth] = useState<CiHealthResponse | null>(null);
  const [prPipeline, setPrPipeline] = useState<PrPipelineResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  async function fetchAll() {
    try {
      const [projRes, ciRes, prRes] = await Promise.all([
        fetch("/api/projects"),
        fetch("/api/ci-health"),
        fetch("/api/pr-pipeline"),
      ]);

      if (!projRes.ok) throw new Error(`/api/projects: ${projRes.status}`);
      if (!ciRes.ok) throw new Error(`/api/ci-health: ${ciRes.status}`);
      if (!prRes.ok) throw new Error(`/api/pr-pipeline: ${prRes.status}`);

      const projJson = (await projRes.json()) as ProjectsApiResponse;
      const ciJson = (await ciRes.json()) as CiHealthResponse;
      const prJson = (await prRes.json()) as PrPipelineResponse;

      setProjects(Array.isArray(projJson.data) ? projJson.data : []);
=======
import {
  getProjects,
  getCiHealth,
  getPrPipeline,
  peek,
  type CiHealthResponse,
  type PrPipelineResponse,
} from "../lib/api";

const POLL_INTERVAL_MS = 60_000;

export default function ProjectsView() {
  // Seed from cache
  const cachedProjects = peek<ProjectEntry[]>("/api/projects");
  const cachedCi = peek<CiHealthResponse>("/api/ci-health");
  const cachedPr = peek<PrPipelineResponse>("/api/pr-pipeline");

  const [projects, setProjects] = useState<ProjectEntry[]>(cachedProjects ?? []);
  const [ciHealth, setCiHealth] = useState<CiHealthResponse | null>(cachedCi ?? null);
  const [prPipeline, setPrPipeline] = useState<PrPipelineResponse | null>(cachedPr ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!(cachedProjects && cachedCi && cachedPr));
  const [lastUpdated, setLastUpdated] = useState<Date | null>(
    cachedProjects && cachedCi && cachedPr ? new Date() : null,
  );

  async function fetchAll(force = false) {
    try {
      const [projData, ciJson, prJson] = await Promise.all([
        getProjects(),
        getCiHealth(force),
        getPrPipeline(force),
      ]);

      setProjects(Array.isArray(projData) ? (projData as ProjectEntry[]) : []);
>>>>>>> origin/main
      setCiHealth(ciJson);
      setPrPipeline(prJson);
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
<<<<<<< HEAD
    fetchAll();
    const timer = setInterval(fetchAll, POLL_INTERVAL_MS);
=======
    fetchAll(true);
    const timer = setInterval(() => fetchAll(true), POLL_INTERVAL_MS);
>>>>>>> origin/main
    return () => clearInterval(timer);
  }, []);

  // Build lookup maps keyed by github repo ("owner/repo")
  const ciByRepo = new Map<string, CiProjectData>(
    (ciHealth?.projects ?? []).map((p) => [p.repo, p])
  );
  const prsByRepo = new Map<string, PrData[]>();
  for (const pr of prPipeline?.prs ?? []) {
    const list = prsByRepo.get(pr.repo) ?? [];
    list.push(pr);
    prsByRepo.set(pr.repo, list);
  }

  const aggregateSuccessRate =
    ciHealth && ciHealth.totalRuns > 0
      ? Math.round(ciHealth.successRate * 100)
      : null;

  return (
    <div class="projects-view">
      {/* Aggregate CI summary */}
      {ciHealth && (
        <div class="pv-summary card">
          <div class="pv-summary-title">CI Summary</div>
          <div class="pv-summary-stats">
            <div class="pv-stat">
              <span class="pv-stat-value" style={{
                color: aggregateSuccessRate !== null && aggregateSuccessRate >= 90
                  ? "var(--text-success)"
                  : aggregateSuccessRate !== null && aggregateSuccessRate >= 70
                    ? "var(--text-warning)"
                    : "var(--text-danger)"
              }}>
                {aggregateSuccessRate !== null ? `${aggregateSuccessRate}%` : "—"}
              </span>
              <span class="pv-stat-label">success rate</span>
            </div>
            <div class="pv-stat">
              <span class="pv-stat-value">{ciHealth.totalRuns}</span>
              <span class="pv-stat-label">total runs</span>
            </div>
            <div class="pv-stat">
              <span class="pv-stat-value" style={{ color: ciHealth.failedRuns > 0 ? "var(--text-danger)" : undefined }}>
                {ciHealth.failedRuns}
              </span>
              <span class="pv-stat-label">failed</span>
            </div>
            {prPipeline && (
              <div class="pv-stat">
                <span class="pv-stat-value">{prPipeline.totalOpen}</span>
                <span class="pv-stat-label">open PRs</span>
              </div>
            )}
          </div>
        </div>
      )}

      <div class="pv-header">
        <h2 class="pv-title">Projects</h2>
        {lastUpdated && (
          <span class="pv-updated">
            Updated {lastUpdated.toLocaleTimeString()}
          </span>
        )}
      </div>

      {loading && (
        <div class="card">
          <p class="placeholder-content">Loading projects…</p>
        </div>
      )}

      {!loading && error && (
        <div class="card" style={{ borderColor: "rgba(248,81,73,0.4)" }}>
          <p style={{ color: "var(--text-danger)", fontSize: "13px" }}>
            Failed to load: {error}
          </p>
        </div>
      )}

      {!loading && !error && projects.length === 0 && (
        <div class="card">
          <p class="placeholder-content">No projects registered</p>
        </div>
      )}

      {!loading && !error && projects.length > 0 && (
        <div class="pv-grid">
          {projects.map((project) => {
            const repo = project.github ?? "";
            return (
              <ProjectCard
                key={project.slug}
                project={project}
                ci={ciByRepo.get(repo) ?? null}
                prs={prsByRepo.get(repo) ?? []}
              />
            );
          })}
        </div>
      )}

      <style>{`
        .projects-view {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }
        .pv-summary {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .pv-summary-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .pv-summary-stats {
          display: flex;
          gap: 32px;
          flex-wrap: wrap;
        }
        .pv-stat {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .pv-stat-value {
          font-size: 22px;
          font-weight: 600;
          color: var(--text-primary);
          line-height: 1;
        }
        .pv-stat-label {
          font-size: 11px;
          color: var(--text-secondary);
        }
        .pv-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .pv-title {
          font-size: 16px;
          font-weight: 600;
        }
        .pv-updated {
          font-size: 12px;
          color: var(--text-secondary);
        }
        .pv-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
          gap: 16px;
        }
      `}</style>
    </div>
  );
}
