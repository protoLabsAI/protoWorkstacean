import { useState } from "preact/hooks";
import CiBar from "./CiBar.tsx";
import PrBadges from "./PrBadges.tsx";

export interface ProjectEntry {
  slug: string;
  title: string;
  github?: string;
  repoUrl?: string;
  agents?: string[];
  status?: string;
  team?: string;
}

export interface CiProjectData {
  repo: string;
  successRate: number;
  totalRuns: number;
  failedRuns: number;
  latestConclusion: string | null;
}

export interface PrData {
  repo: string;
  number: number;
  title: string;
  mergeable: string;
  checksPass: boolean;
  updatedAt: string;
  stale: boolean;
}

interface ProjectCardProps {
  project: ProjectEntry;
  ci: CiProjectData | null;
  prs: PrData[];
}

function formatUpdatedAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function ProjectCard({ project, ci, prs }: ProjectCardProps) {
  const [prsExpanded, setPrsExpanded] = useState(false);

  const openCount = prs.length;
  const conflicting = prs.filter((p) => p.mergeable === "dirty").length;
  const stale = prs.filter((p) => p.stale).length;
  const failing = prs.filter((p) => !p.checksPass).length;

  const conclusionColor =
    ci?.latestConclusion === "success"
      ? "var(--text-success)"
      : ci?.latestConclusion === "failure"
        ? "var(--text-danger)"
        : "var(--text-secondary)";

  return (
    <div class="project-card card">
      {/* Header */}
      <div class="pc-header">
        <div class="pc-title-row">
          <span class="pc-title">{project.title}</span>
          <span class="badge badge-blue">{project.status ?? "active"}</span>
        </div>
        <div class="pc-meta">
          {project.github && (
            <a
              href={project.repoUrl ?? `https://github.com/${project.github}`}
              target="_blank"
              rel="noopener noreferrer"
              class="pc-github-link"
            >
              {project.github}
            </a>
          )}
          {project.agents && project.agents.length > 0 && (
            <span class="pc-agents">
              {project.agents.map((a) => (
                <span key={a} class="badge badge-blue pc-agent-badge">
                  {a}
                </span>
              ))}
            </span>
          )}
        </div>
      </div>

      {/* CI Section */}
      <div class="pc-section">
        <div class="pc-section-label">CI Health</div>
        {ci ? (
          <div class="pc-ci">
            <CiBar
              successRate={ci.successRate}
              totalRuns={ci.totalRuns}
              failedRuns={ci.failedRuns}
            />
            {ci.latestConclusion && (
              <span class="pc-conclusion" style={{ color: conclusionColor }}>
                latest: {ci.latestConclusion}
              </span>
            )}
          </div>
        ) : (
          <span class="pc-no-data">No CI data</span>
        )}
      </div>

      {/* PR Section */}
      <div class="pc-section">
        <div class="pc-section-label">
          Pull Requests
          {openCount > 0 && (
            <span class="pc-pr-count">{openCount} open</span>
          )}
        </div>
        <div class="pc-pr-row">
          <PrBadges conflicting={conflicting} stale={stale} failing={failing} />
          {openCount > 0 && (
            <button
              class="pc-expand-btn"
              onClick={() => setPrsExpanded((v) => !v)}
            >
              {prsExpanded ? "Hide" : "Show"} PRs
            </button>
          )}
        </div>

        {prsExpanded && openCount > 0 && (
          <div class="pc-pr-list">
            {prs.map((pr) => (
              <div key={`${pr.repo}/${pr.number}`} class="pc-pr-item">
                <span class="pc-pr-number">#{pr.number}</span>
                <span class="pc-pr-title">{pr.title}</span>
                <span class="pc-pr-badges">
                  {pr.mergeable === "dirty" && (
                    <span class="badge badge-red">conflict</span>
                  )}
                  {pr.stale && <span class="badge badge-yellow">stale</span>}
                  {!pr.checksPass && (
                    <span class="badge badge-red">failing</span>
                  )}
                </span>
                <span class="pc-pr-date">{formatUpdatedAt(pr.updatedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <style>{`
        .project-card {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .pc-header {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .pc-title-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .pc-title {
          font-size: 15px;
          font-weight: 600;
          color: var(--text-primary);
        }
        .pc-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .pc-github-link {
          font-size: 12px;
          color: var(--text-link);
        }
        .pc-agents {
          display: inline-flex;
          gap: 4px;
        }
        .pc-agent-badge {
          font-size: 10px;
          padding: 1px 6px;
        }
        .pc-section {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding-top: 12px;
          border-top: 1px solid var(--border-muted);
        }
        .pc-section-label {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.05em;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .pc-pr-count {
          font-size: 11px;
          font-weight: 500;
          color: var(--text-primary);
          text-transform: none;
          letter-spacing: 0;
        }
        .pc-ci {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .pc-conclusion {
          font-size: 11px;
        }
        .pc-no-data {
          font-size: 12px;
          color: var(--text-secondary);
          font-style: italic;
        }
        .pc-pr-row {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .pc-expand-btn {
          background: none;
          border: 1px solid var(--border-default);
          color: var(--text-secondary);
          font-size: 11px;
          padding: 2px 8px;
          border-radius: 4px;
          cursor: pointer;
          transition: color 0.1s, border-color 0.1s;
        }
        .pc-expand-btn:hover {
          color: var(--text-primary);
          border-color: var(--text-secondary);
        }
        .pc-pr-list {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-top: 4px;
        }
        .pc-pr-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 8px;
          background: var(--bg-subtle);
          border-radius: 4px;
          font-size: 12px;
        }
        .pc-pr-number {
          color: var(--text-secondary);
          flex-shrink: 0;
          font-size: 11px;
        }
        .pc-pr-title {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: var(--text-primary);
        }
        .pc-pr-badges {
          display: flex;
          gap: 4px;
          flex-shrink: 0;
        }
        .pc-pr-date {
          color: var(--text-secondary);
          font-size: 11px;
          flex-shrink: 0;
        }
      `}</style>
    </div>
  );
}
