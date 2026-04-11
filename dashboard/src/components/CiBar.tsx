interface CiBarProps {
  successRate: number; // 0.0 – 1.0
  totalRuns: number;
  failedRuns: number;
}

export default function CiBar({ successRate, totalRuns, failedRuns }: CiBarProps) {
  const pct = Math.round(successRate * 100);
  const color =
    pct >= 90
      ? "var(--text-success)"
      : pct >= 70
        ? "var(--text-warning)"
        : "var(--text-danger)";

  return (
    <div class="ci-bar">
      <div class="ci-bar__track">
        <div
          class="ci-bar__fill"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <div class="ci-bar__labels">
        <span class="ci-bar__pct" style={{ color }}>
          {pct}%
        </span>
        <span class="ci-bar__detail">
          {totalRuns} runs · {failedRuns} failed
        </span>
      </div>
      <style>{`
        .ci-bar {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .ci-bar__track {
          height: 6px;
          background: var(--bg-subtle);
          border-radius: 3px;
          overflow: hidden;
        }
        .ci-bar__fill {
          height: 100%;
          border-radius: 3px;
          transition: width 0.3s ease;
        }
        .ci-bar__labels {
          display: flex;
          align-items: center;
          justify-content: space-between;
          font-size: 11px;
        }
        .ci-bar__pct {
          font-weight: 600;
        }
        .ci-bar__detail {
          color: var(--text-secondary);
        }
      `}</style>
    </div>
  );
}
