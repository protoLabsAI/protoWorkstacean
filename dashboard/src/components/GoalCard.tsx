import type { Goal, EvalResult } from "../lib/goal-evaluator.ts";

export interface GoalCardProps {
  goal: Goal;
  result: EvalResult;
}

const severityColors: Record<string, string> = {
  critical: "var(--text-danger)",
  high: "var(--text-warning)",
  medium: "var(--accent-fg)",
  low: "var(--text-secondary)",
};

const typeLabel: Record<string, string> = {
  Threshold: "Threshold",
  Invariant: "Invariant",
  Distribution: "Distribution",
};

export default function GoalCard({ goal, result }: GoalCardProps) {
  const pass = result.status === "pass";
  const unknown = result.status === "unknown";
  const severity = goal.severity ?? "medium";
  const sevColor = severityColors[severity] ?? "var(--text-secondary)";

  const borderColor = unknown
    ? "var(--border-default)"
    : pass
      ? "rgba(63, 185, 80, 0.4)"
      : "rgba(248, 81, 73, 0.4)";

  const indicatorColor = unknown
    ? "var(--text-secondary)"
    : pass
      ? "var(--text-success)"
      : "var(--text-danger)";

  const indicatorLabel = unknown ? "?" : pass ? "✓" : "✗";
  const statusBadgeClass = unknown
    ? "badge badge-blue"
    : pass
      ? "badge badge-green"
      : "badge badge-red";
  const statusText = unknown ? "unknown" : pass ? "pass" : "fail";

  // Build threshold range label
  let thresholdLabel: string | null = null;
  if (goal.type === "Threshold") {
    const min = "min" in goal ? goal.min : undefined;
    const max = "max" in goal ? goal.max : undefined;
    if (min !== undefined && max !== undefined) thresholdLabel = `${min} ≤ x ≤ ${max}`;
    else if (min !== undefined) thresholdLabel = `≥ ${min}`;
    else if (max !== undefined) thresholdLabel = `≤ ${max}`;
  }

  return (
    <div class="goal-card card" style={{ borderColor }}>
      <div class="goal-card__header">
        <div class="goal-card__left">
          <span
            class="goal-card__indicator"
            style={{ color: indicatorColor, borderColor: indicatorColor }}
          >
            {indicatorLabel}
          </span>
          <div class="goal-card__title-group">
            <span class="goal-card__id">{goal.id}</span>
            <span class="goal-card__desc">{goal.description}</span>
          </div>
        </div>
        <div class="goal-card__badges">
          <span class="badge badge-blue">{typeLabel[goal.type] ?? goal.type}</span>
          <span class="badge" style={{ background: `${sevColor}22`, color: sevColor }}>
            {severity}
          </span>
          <span class={statusBadgeClass}>{statusText}</span>
        </div>
      </div>

      <div class="goal-card__detail">
        {"selector" in goal && (
          <span class="goal-card__selector">{(goal as { selector: string }).selector}</span>
        )}
        {result.actual !== undefined && result.actual !== null && (
          <span class="goal-card__value">
            value: <code>{JSON.stringify(result.actual)}</code>
          </span>
        )}
        {thresholdLabel && (
          <span class="goal-card__threshold">range: {thresholdLabel}</span>
        )}
        {!pass && result.message && (
          <span class="goal-card__message">{result.message}</span>
        )}
      </div>

      <style>{`
        .goal-card {
          display: flex;
          flex-direction: column;
          gap: 10px;
          transition: border-color 0.2s;
        }
        .goal-card__header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
        }
        .goal-card__left {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          min-width: 0;
        }
        .goal-card__indicator {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          border: 2px solid;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          font-weight: 700;
          flex-shrink: 0;
        }
        .goal-card__title-group {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .goal-card__id {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .goal-card__desc {
          font-size: 12px;
          color: var(--text-secondary);
        }
        .goal-card__badges {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
        }
        .goal-card__detail {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          align-items: center;
          padding-top: 4px;
          border-top: 1px solid var(--border-muted);
        }
        .goal-card__selector {
          font-size: 11px;
          color: var(--text-secondary);
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
          background: var(--bg-inset);
          padding: 2px 6px;
          border-radius: 4px;
        }
        .goal-card__value {
          font-size: 12px;
          color: var(--text-secondary);
        }
        .goal-card__value code {
          color: var(--accent-fg);
        }
        .goal-card__threshold {
          font-size: 12px;
          color: var(--text-secondary);
          font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
        }
        .goal-card__message {
          font-size: 11px;
          color: var(--text-danger);
          background: rgba(248, 81, 73, 0.08);
          border: 1px solid rgba(248, 81, 73, 0.2);
          border-radius: 4px;
          padding: 3px 8px;
          flex: 1 1 100%;
        }
      `}</style>
    </div>
  );
}
