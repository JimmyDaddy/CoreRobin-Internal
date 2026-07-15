import { useId, useMemo, useState } from "react";
import {
  useAppTranslation,
  type AppTFunction,
} from "../i18n/useAppTranslation";

import {
  PROCESS_HISTORY_WINDOW_MS,
  type SelectedProcessHistory,
} from "../processExplorer";
import type { ProcessHistoryPoint } from "../types";
import { formatBytes, formatPercent, formatRate } from "../utils";

type HistoryMetric = "cpu" | "memory" | "io";

interface ProcessHistoryProps {
  history: SelectedProcessHistory | null;
}

interface ChartSeries {
  key: string;
  label: string;
  className: string;
  dashed: boolean;
  values: Array<number | null>;
}

interface MetricSummary {
  current: string;
  average: string;
  peak: string;
}

interface PositionedPoint {
  x: number;
  y: number;
}

const CHART_WIDTH = 260;
const CHART_HEIGHT = 96;
const PLOT_LEFT = 8;
const PLOT_RIGHT = 252;
const PLOT_TOP = 8;
const PLOT_BOTTOM = 76;
const MAX_CONNECTED_SAMPLE_GAP_MS = 5_000;

const METRICS: HistoryMetric[] = ["cpu", "memory", "io"];

export function ProcessHistory({ history }: ProcessHistoryProps) {
  const { t } = useAppTranslation();
  const [metric, setMetric] = useState<HistoryMetric>("cpu");
  const titleId = useId();
  const descriptionId = useId();
  const chart = useMemo(() => buildChart(history, metric, t), [history, metric, t]);

  return (
    <section className="process-history" aria-labelledby={`${titleId}-section`}>
      <header className="process-history__header">
        <div>
          <span className="eyebrow">{t("process:history.retained")}</span>
          <h3 id={`${titleId}-section`}>{t("process:history.title")}</h3>
        </div>
        <div className="process-history__segments" role="group" aria-label={t("process:history.metrics")}>
          {METRICS.map((candidate) => (
            <button
              type="button"
              className={`process-history__segment${metric === candidate ? " is-active" : ""}`}
              aria-pressed={metric === candidate}
              key={candidate}
              onClick={() => setMetric(candidate)}
            >
              {candidate === "cpu"
                ? "CPU"
                : candidate === "memory"
                  ? t("process:history.memory")
                  : "I/O"}
            </button>
          ))}
        </div>
      </header>

      {!history || chart.points.length === 0 ? (
        <div className="process-history__empty">
          {t("process:history.empty")}
        </div>
      ) : (
        <>
          <svg
            className="process-history__chart"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            role="img"
            aria-labelledby={`${titleId} ${descriptionId}`}
            focusable="false"
          >
            <title id={titleId}>{t("process:history.chartTitle", { name: history.name || `PID ${history.pid}`, metric: chart.label })}</title>
            <desc id={descriptionId}>
              {t("process:history.chartDescription", {
                current: chart.summary.current,
                average: chart.summary.average,
                peak: chart.summary.peak,
              })}
            </desc>
            <g className="process-history__grid" aria-hidden="true">
              {[PLOT_TOP, (PLOT_TOP + PLOT_BOTTOM) / 2, PLOT_BOTTOM].map((y) => (
                <line x1={PLOT_LEFT} x2={PLOT_RIGHT} y1={y} y2={y} key={`horizontal-${y}`} />
              ))}
              <line x1={PLOT_LEFT} x2={PLOT_LEFT} y1={PLOT_TOP} y2={PLOT_BOTTOM} />
              <line x1={PLOT_RIGHT} x2={PLOT_RIGHT} y1={PLOT_TOP} y2={PLOT_BOTTOM} />
            </g>
            <g aria-hidden="true">
              {chart.series.flatMap((series) =>
                buildProcessHistoryLineSegments(
                  chart.points,
                  series.values,
                  chart.windowStart,
                  chart.windowEnd,
                  chart.yMaximum,
                ).map((path, index) => (
                  <path
                    className={`process-history__line ${series.className}${series.dashed ? " process-history__line--dashed" : ""}`}
                    d={path}
                    key={`${series.key}-${index}`}
                  />
                )),
              )}
            </g>
            <g className="process-history__axis" aria-hidden="true">
              <text x={PLOT_LEFT} y={91}>{t("common:fiveMinutesBack")}</text>
              <text x={PLOT_RIGHT} y={91} textAnchor="end">{t("common:now")}</text>
            </g>
          </svg>

          {metric === "io" ? (
            <div className="process-history__legend" aria-hidden="true">
              {chart.series.map((series) => (
                <span key={series.key}>
                  <i className={`${series.className}${series.dashed ? " is-dashed" : ""}`} />
                  {series.label}
                </span>
              ))}
            </div>
          ) : null}

          <dl className="process-history__summary">
            <div><dt>{t("common:current")}</dt><dd>{chart.summary.current}</dd></div>
            <div><dt>{t("common:average")}</dt><dd>{chart.summary.average}</dd></div>
            <div><dt>{t("common:peak")}</dt><dd>{chart.summary.peak}</dd></div>
          </dl>
          {history.missing ? (
            <p className="process-history__missing" role="status">{t("process:history.exited")}</p>
          ) : null}
        </>
      )}
    </section>
  );
}

function buildChart(
  history: SelectedProcessHistory | null,
  metric: HistoryMetric,
  t: AppTFunction,
) {
  const allPoints = history?.points ?? [];
  const windowEnd = allPoints[allPoints.length - 1]?.timestamp ?? 0;
  const windowStart = windowEnd - PROCESS_HISTORY_WINDOW_MS;
  const points = allPoints
    .filter((point) => point.timestamp >= windowStart && point.timestamp <= windowEnd)
    .slice()
    .sort((left, right) => left.timestamp - right.timestamp);

  if (metric === "cpu") {
    const values = points.map((point) => finiteOrNull(point.cpuPercent));
    return {
      label: "CPU",
      points,
      windowStart,
      windowEnd,
      yMaximum: roundedCpuMaximum(values),
      series: [series("cpu", "CPU", "process-history__line--cpu", false, values)],
      summary: summarize(values, formatPercent, t("common:unavailable")),
    };
  }

  if (metric === "memory") {
    const values = points.map((point) => finiteOrNull(point.memoryBytes));
    return {
      label: t("process:history.memory"),
      points,
      windowStart,
      windowEnd,
      yMaximum: positiveMaximum(values),
      series: [series("memory", t("process:history.memory"), "process-history__line--memory", false, values)],
      summary: summarize(
        values,
        (value) => (value === null ? t("common:unavailable") : formatBytes(value)),
        t("common:unavailable"),
      ),
    };
  }

  const readValues = points.map((point) => finiteOrNull(point.diskReadBytesPerSecond));
  const writeValues = points.map((point) => finiteOrNull(point.diskWriteBytesPerSecond));
  const totals = points.map((_, index) => addNullable(readValues[index], writeValues[index]));
  return {
    label: t("process:history.diskIo"),
    points,
    windowStart,
    windowEnd,
    yMaximum: positiveMaximum([...readValues, ...writeValues]),
    series: [
      series("read", t("common:read"), "process-history__line--read", false, readValues),
      series("write", t("common:write"), "process-history__line--write", true, writeValues),
    ],
    summary: summarize(totals, formatRate, t("common:unavailable")),
  };
}

function series(
  key: string,
  label: string,
  className: string,
  dashed: boolean,
  values: Array<number | null>,
): ChartSeries {
  return { key, label, className, dashed, values };
}

export function buildProcessHistoryLineSegments(
  points: readonly ProcessHistoryPoint[],
  values: readonly (number | null)[],
  windowStart: number,
  windowEnd: number,
  yMaximum: number,
): string[] {
  const duration = Math.max(1, windowEnd - windowStart);
  const positioned: Array<PositionedPoint | null> = points.map((point, index) => {
    const value = values[index];
    if (value === null) return null;
    return {
      x: PLOT_LEFT + ((point.timestamp - windowStart) / duration) * (PLOT_RIGHT - PLOT_LEFT),
      y: PLOT_BOTTOM - (Math.max(0, value) / yMaximum) * (PLOT_BOTTOM - PLOT_TOP),
    };
  });

  const segments: PositionedPoint[][] = [];
  let current: PositionedPoint[] = [];
  for (const [index, point] of positioned.entries()) {
    const priorTimestamp = points[index - 1]?.timestamp;
    const currentTimestamp = points[index]?.timestamp;
    const followsSamplingGap =
      priorTimestamp !== undefined &&
      currentTimestamp !== undefined &&
      currentTimestamp - priorTimestamp > MAX_CONNECTED_SAMPLE_GAP_MS;
    if (followsSamplingGap && current.length > 0) {
      segments.push(current);
      current = [];
    }
    if (point === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);

  return segments.map((segment) => {
    const commands = segment.map(
      (point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
    );
    if (segment.length === 1) commands.push("h 0.01");
    return commands.join(" ");
  });
}

function summarize(
  values: readonly (number | null)[],
  formatter: (value: number | null) => string,
  unavailable: string,
): MetricSummary {
  const available = values.filter((value): value is number => value !== null);
  const current = values[values.length - 1] ?? null;
  if (available.length === 0) {
    return { current: formatter(current), average: unavailable, peak: unavailable };
  }
  const average = available.reduce((sum, value) => sum + value, 0) / available.length;
  const peak = Math.max(...available);
  return {
    current: formatter(current),
    average: formatter(average),
    peak: formatter(peak),
  };
}

function finiteOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) ? Math.max(0, value) : null;
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

function positiveMaximum(values: readonly (number | null)[]): number {
  return Math.max(1, ...values.filter((value): value is number => value !== null));
}

function roundedCpuMaximum(values: readonly (number | null)[]): number {
  const maximum = Math.max(100, positiveMaximum(values));
  return Math.ceil(maximum / 25) * 25;
}
