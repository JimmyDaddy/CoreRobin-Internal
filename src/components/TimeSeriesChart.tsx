import { useMemo, useState, type CSSProperties, type MouseEvent } from "react";

import {
  splitTimeSeriesSegments,
  timeSeriesCompleteness,
  type TimeSeriesPoint,
} from "../timeSeries";
import "./TimeSeriesChart.css";

export interface TimeSeriesDefinition {
  label: string;
  color: string;
  dashed?: boolean;
  format: (value: number) => string;
}

interface TimeSeriesChartProps {
  points: readonly TimeSeriesPoint[];
  series: readonly TimeSeriesDefinition[];
  startAtMs: number;
  endAtMs: number;
  expectedIntervalMs: number;
  gapThresholdMs?: number;
  maximum?: number;
  language?: string;
  ariaLabel: string;
  earlierLabel: string;
  nowLabel: string;
  completenessLabel: (percent: number) => string;
  className?: string;
  onSelectPoint?: (point: TimeSeriesPoint) => void;
}

const WIDTH = 900;
const HEIGHT = 210;
const TOP = 14;
const BOTTOM = 174;

export function TimeSeriesChart({
  points,
  series,
  startAtMs,
  endAtMs,
  expectedIntervalMs,
  gapThresholdMs = expectedIntervalMs * 2.5,
  maximum,
  language,
  ariaLabel,
  earlierLabel,
  nowLabel,
  completenessLabel,
  className,
  onSelectPoint,
}: TimeSeriesChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const ordered = useMemo(
    () => [...points]
      .filter(({ timestamp }) => timestamp >= startAtMs && timestamp <= endAtMs)
      .sort((left, right) => left.timestamp - right.timestamp),
    [endAtMs, points, startAtMs],
  );
  const scale = maximum ?? Math.max(
    1,
    ...ordered.flatMap(({ values }) =>
      values.flatMap((value) => value === null ? [] : [Math.max(0, value)])),
  );
  const completeness = timeSeriesCompleteness(
    ordered,
    startAtMs,
    endAtMs,
    expectedIntervalMs,
  );
  const hovered = hoveredIndex === null ? null : ordered[hoveredIndex] ?? null;

  const handlePointer = (event: MouseEvent<HTMLDivElement>) => {
    if (ordered.length === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const timestamp =
      startAtMs + (event.clientX - bounds.left) / Math.max(1, bounds.width)
      * (endAtMs - startAtMs);
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    ordered.forEach((point, index) => {
      const distance = Math.abs(point.timestamp - timestamp);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    });
    setHoveredIndex(closestIndex);
  };

  return (
    <div
      className={`time-series-chart${className ? ` ${className}` : ""}`}
      onMouseMove={handlePointer}
      onMouseLeave={() => setHoveredIndex(null)}
      onClick={() => {
        if (hovered && onSelectPoint) onSelectPoint(hovered);
      }}
      data-selectable={onSelectPoint ? "true" : undefined}
    >
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
      >
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            className="time-series-chart__grid"
            key={ratio}
            x1="0"
            x2={WIDTH}
            y1={TOP + ratio * (BOTTOM - TOP)}
            y2={TOP + ratio * (BOTTOM - TOP)}
          />
        ))}
        {series.map((definition, seriesIndex) =>
          splitTimeSeriesSegments(ordered, seriesIndex, gapThresholdMs).map(
            (segment, segmentIndex) => (
              <path
                className={`time-series-chart__line${definition.dashed ? " is-dashed" : ""}`}
                d={seriesPath(
                  segment,
                  seriesIndex,
                  startAtMs,
                  endAtMs,
                  scale,
                )}
                key={`${definition.label}-${segmentIndex}`}
                style={{ "--time-series-color": definition.color } as CSSProperties}
              />
            ),
          ))}
        {hovered ? (
          <line
            className="time-series-chart__cursor"
            x1={xFor(hovered.timestamp, startAtMs, endAtMs)}
            x2={xFor(hovered.timestamp, startAtMs, endAtMs)}
            y1={TOP}
            y2={BOTTOM}
          />
        ) : null}
        <text x="0" y={HEIGHT - 4}>{earlierLabel}</text>
        <text x={WIDTH} y={HEIGHT - 4} textAnchor="end">{nowLabel}</text>
      </svg>
      <span className="time-series-chart__completeness">
        {completenessLabel(Math.round(completeness.percent))}
      </span>
      {hovered ? (
        <div
          className="time-series-chart__tooltip"
          style={{
            left: `${Math.min(
              88,
              Math.max(12, (hovered.timestamp - startAtMs)
                / Math.max(1, endAtMs - startAtMs) * 100),
            )}%`,
          }}
          role="status"
        >
          <strong>
            {new Intl.DateTimeFormat(language, {
              dateStyle: "medium",
              timeStyle: "medium",
            }).format(hovered.timestamp)}
          </strong>
          {series.map((definition, index) => {
            const value = hovered.values[index];
            return (
              <span key={definition.label}>
                <i style={{ background: definition.color }} />
                {definition.label}
                <b>{value === null || value === undefined
                  ? "—"
                  : definition.format(value)}</b>
              </span>
            );
          })}
          <small>{completenessLabel(Math.round(completeness.percent))}</small>
        </div>
      ) : null}
    </div>
  );
}

function seriesPath(
  points: readonly TimeSeriesPoint[],
  seriesIndex: number,
  startAtMs: number,
  endAtMs: number,
  maximum: number,
): string {
  const height = BOTTOM - TOP;
  const commands = points.map((point, index) => {
    const value = point.values[seriesIndex] ?? 0;
    const x = xFor(point.timestamp, startAtMs, endAtMs);
    const y = TOP + (1 - Math.min(maximum, Math.max(0, value)) / maximum) * height;
    return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  if (commands.length === 1) commands.push("h0.01");
  return commands.join(" ");
}

function xFor(timestamp: number, startAtMs: number, endAtMs: number): number {
  return (timestamp - startAtMs) / Math.max(1, endAtMs - startAtMs) * WIDTH;
}
