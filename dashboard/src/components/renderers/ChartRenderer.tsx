// ChartRenderer — renders a line, bar, or area chart from a ChartWidgetDescriptor.
//
// Uses inline SVG (no external charting library) for Preact compatibility.
// Supports responsive layout, dark mode via CSS variables, and graceful
// handling of missing or invalid data.

import { useState, useEffect } from "preact/hooks";
import type { ChartWidgetDescriptor } from "../../lib/widget-renderer";
import { fetchWidgetData } from "../../lib/widget-renderer";

const DEFAULT_COLORS = [
  "#58a6ff",
  "#3fb950",
  "#d29922",
  "#f85149",
  "#bc8cff",
  "#79c0ff",
];

// SVG viewBox dimensions
const VB_WIDTH = 480;
const PAD = { top: 16, right: 16, bottom: 36, left: 52 };

type DataRow = Record<string, unknown>;

function toNum(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function formatAxisLabel(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") {
    if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
    return v.toFixed(v % 1 === 0 ? 0 : 1);
  }
  const s = String(v);
  return s.length > 8 ? s.slice(0, 8) + "…" : s;
}

interface PlotArea {
  w: number;
  h: number;
}

function computePlotArea(vbHeight: number): PlotArea {
  return {
    w: VB_WIDTH - PAD.left - PAD.right,
    h: vbHeight - PAD.top - PAD.bottom,
  };
}

function yRange(data: DataRow[], yKeys: string[]): { min: number; max: number } {
  const allValues = data.flatMap((row) => yKeys.map((k) => toNum(row[k])));
  if (allValues.length === 0) return { min: 0, max: 1 };
  const min = Math.min(0, ...allValues);
  const max = Math.max(...allValues);
  return { min, max: max === min ? min + 1 : max };
}

function toX(i: number, count: number, plotW: number): number {
  if (count <= 1) return PAD.left + plotW / 2;
  return PAD.left + (i / (count - 1)) * plotW;
}

function toY(
  value: number,
  min: number,
  max: number,
  plotH: number,
  vbHeight: number,
): number {
  const range = max - min || 1;
  return PAD.top + plotH - ((value - min) / range) * plotH;
}

interface LineSeriesProps {
  data: DataRow[];
  xKey: string;
  yKey: string;
  color: string;
  vbHeight: number;
  min: number;
  max: number;
  area?: boolean;
}

function LineSeries({ data, yKey, color, vbHeight, min, max, area }: LineSeriesProps) {
  const { w, h } = computePlotArea(vbHeight);
  if (data.length === 0) return null;

  const points = data.map((row, i) => ({
    x: toX(i, data.length, w),
    y: toY(toNum(row[yKey]), min, max, h, vbHeight),
  }));

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");

  const areaPath = area
    ? `${linePath} L${points[points.length - 1].x.toFixed(1)},${(PAD.top + h).toFixed(1)} L${points[0].x.toFixed(1)},${(PAD.top + h).toFixed(1)} Z`
    : null;

  return (
    <g>
      {areaPath && (
        <path
          d={areaPath}
          fill={color}
          fill-opacity="0.12"
          stroke="none"
        />
      )}
      <path d={linePath} fill="none" stroke={color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      {data.length <= 20 &&
        points.map((p, i) => (
          <circle key={i} cx={p.x.toFixed(1)} cy={p.y.toFixed(1)} r="3" fill={color} />
        ))}
    </g>
  );
}

interface BarSeriesProps {
  data: DataRow[];
  yKeys: string[];
  colors: string[];
  vbHeight: number;
  max: number;
}

function BarSeries({ data, yKeys, colors, vbHeight, max }: BarSeriesProps) {
  const { w, h } = computePlotArea(vbHeight);
  if (data.length === 0) return null;

  const groupW = w / data.length;
  const barW = Math.max(2, (groupW / (yKeys.length + 1)) * 0.85);
  const baseline = PAD.top + h;

  return (
    <g>
      {data.map((row, i) => {
        const groupX = PAD.left + i * groupW;
        return yKeys.map((key, ki) => {
          const value = toNum(row[key]);
          const barH = Math.max(0, (value / (max || 1)) * h);
          const x = groupX + (ki + 0.5) * (groupW / (yKeys.length + 1)) - barW / 2;
          const y = baseline - barH;
          return (
            <rect
              key={`${i}-${ki}`}
              x={x.toFixed(1)}
              y={y.toFixed(1)}
              width={barW.toFixed(1)}
              height={barH.toFixed(1)}
              fill={colors[ki % colors.length]}
              rx="2"
            />
          );
        });
      })}
    </g>
  );
}

interface AxesProps {
  data: DataRow[];
  xKey: string;
  min: number;
  max: number;
  vbHeight: number;
}

function Axes({ data, xKey, min, max, vbHeight }: AxesProps) {
  const { w, h } = computePlotArea(vbHeight);
  const baseline = PAD.top + h;

  // Y-axis tick count
  const tickCount = 4;
  const yTicks = Array.from({ length: tickCount + 1 }, (_, i) => {
    const frac = i / tickCount;
    return min + frac * (max - min);
  });

  // X labels — show at most 8 evenly spaced
  const maxXLabels = 8;
  const step = data.length <= maxXLabels ? 1 : Math.ceil(data.length / maxXLabels);
  const xLabelIndices = data
    .map((_, i) => i)
    .filter((i) => i % step === 0 || i === data.length - 1);

  return (
    <g fill="var(--text-muted, #8b949e)" font-size="10" font-family="monospace">
      {/* Y-axis line */}
      <line
        x1={PAD.left}
        y1={PAD.top}
        x2={PAD.left}
        y2={baseline}
        stroke="var(--border-default, #30363d)"
        stroke-width="1"
      />
      {/* X-axis line */}
      <line
        x1={PAD.left}
        y1={baseline}
        x2={PAD.left + w}
        y2={baseline}
        stroke="var(--border-default, #30363d)"
        stroke-width="1"
      />
      {/* Y gridlines + labels */}
      {yTicks.map((tick, i) => {
        const y = toY(tick, min, max, h, vbHeight);
        return (
          <g key={i}>
            <line
              x1={PAD.left}
              y1={y.toFixed(1)}
              x2={PAD.left + w}
              y2={y.toFixed(1)}
              stroke="var(--border-default, #30363d)"
              stroke-width="0.5"
              stroke-dasharray={i === 0 ? "none" : "3,3"}
            />
            <text x={(PAD.left - 4).toFixed(1)} y={(y + 3).toFixed(1)} text-anchor="end">
              {formatAxisLabel(tick)}
            </text>
          </g>
        );
      })}
      {/* X labels */}
      {xLabelIndices.map((i) => {
        const x = toX(i, data.length, w);
        return (
          <text
            key={i}
            x={x.toFixed(1)}
            y={(baseline + 14).toFixed(1)}
            text-anchor="middle"
            transform={`rotate(-30, ${x.toFixed(1)}, ${(baseline + 14).toFixed(1)})`}
          >
            {formatAxisLabel(data[i][xKey])}
          </text>
        );
      })}
    </g>
  );
}

interface ChartRendererProps {
  descriptor: ChartWidgetDescriptor;
}

export default function ChartRenderer({ descriptor }: ChartRendererProps) {
  const [data, setData] = useState<DataRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { config } = descriptor;
  const vbHeight = config.height ?? 220;
  const colors = config.colors ?? DEFAULT_COLORS;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const result = await fetchWidgetData<unknown>(descriptor);
        if (cancelled) return;
        if (!Array.isArray(result)) {
          setError("Expected array data for chart");
          return;
        }
        setData(result as DataRow[]);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      }
    }

    load();
    const ttl = descriptor.query.ttl ?? 30_000;
    const id = setInterval(load, ttl);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [descriptor.id, descriptor.query.url]);

  return (
    <>
      <style>{`
        .chart-renderer {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .chart-renderer__title {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary, #e6edf3);
          letter-spacing: 0.02em;
        }
        .chart-renderer__svg {
          width: 100%;
          height: auto;
          display: block;
        }
        .chart-renderer__error {
          font-size: 12px;
          color: var(--text-muted, #8b949e);
          padding: 24px 0;
          text-align: center;
        }
        .chart-renderer__legend {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
        }
        .chart-renderer__legend-item {
          display: flex;
          align-items: center;
          gap: 5px;
          font-size: 11px;
          color: var(--text-secondary, #8b949e);
        }
        .chart-renderer__legend-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
        }
      `}</style>
      <div class="chart-renderer">
        <div class="chart-renderer__title">{descriptor.title}</div>

        {error ? (
          <div class="chart-renderer__error">{error}</div>
        ) : data === null ? (
          <div class="chart-renderer__error">Loading…</div>
        ) : data.length === 0 ? (
          <div class="chart-renderer__error">No data</div>
        ) : (
          <>
            <svg
              class="chart-renderer__svg"
              viewBox={`0 0 ${VB_WIDTH} ${vbHeight}`}
              aria-label={descriptor.title}
            >
              <Axes
                data={data}
                xKey={config.xKey}
                min={config.type === "bar" ? 0 : yRange(data, config.yKeys).min}
                max={yRange(data, config.yKeys).max}
                vbHeight={vbHeight}
              />
              {config.type === "bar" ? (
                <BarSeries
                  data={data}
                  yKeys={config.yKeys}
                  colors={colors}
                  vbHeight={vbHeight}
                  max={yRange(data, config.yKeys).max}
                />
              ) : (
                config.yKeys.map((yKey, ki) => {
                  const { min, max } = yRange(data, config.yKeys);
                  return (
                    <LineSeries
                      key={yKey}
                      data={data}
                      xKey={config.xKey}
                      yKey={yKey}
                      color={colors[ki % colors.length]}
                      vbHeight={vbHeight}
                      min={min}
                      max={max}
                      area={config.type === "area"}
                    />
                  );
                })
              )}
            </svg>

            {config.yKeys.length > 1 && (
              <div class="chart-renderer__legend">
                {config.yKeys.map((key, i) => (
                  <div key={key} class="chart-renderer__legend-item">
                    <span
                      class="chart-renderer__legend-dot"
                      style={{ background: colors[i % colors.length] }}
                    />
                    {key}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
