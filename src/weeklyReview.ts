import type { NetworkQualityHistoryPoint } from "./networkQualityHistory";
import type { ResourceAlertEvent } from "./resourceAlerts";
import {
  observedActionEffects,
  type ActionObservedEffect,
} from "./todayReview";
import type { HistoryPoint } from "./types";
import type {
  UserActionKind,
  UserActionRecord,
} from "./userActionHistory";

export interface ReviewPeriodSummary {
  fromMs: number;
  toMs: number;
  anomalyCount: number;
  networkEventCount: number;
  completedActionCount: number;
  observedImprovementCount: number;
  averageCpuPercent: number | null;
  averageMemoryPercent: number | null;
}

export interface ObservedImprovement {
  record: UserActionRecord;
  metrics: ("cpu" | "memory")[];
}

export interface WeeklyReviewSummary {
  today: ReviewPeriodSummary;
  yesterday: ReviewPeriodSummary;
  sevenDays: ReviewPeriodSummary;
  sevenDayDailyAverageAnomalies: number;
  improvements: ObservedImprovement[];
  completedActionKinds: UserActionKind[];
  dataDayCount: number;
}

export function buildWeeklyReview({
  points,
  alerts,
  networkQualityPoints,
  actions,
  nowMs = Date.now(),
}: {
  points: readonly HistoryPoint[];
  alerts: readonly ResourceAlertEvent[];
  networkQualityPoints: readonly NetworkQualityHistoryPoint[];
  actions: readonly UserActionRecord[];
  nowMs?: number;
}): WeeklyReviewSummary {
  const todayStart = startOfLocalDay(nowMs);
  const yesterdayStart = shiftLocalDays(todayStart, -1);
  const sevenDayStart = shiftLocalDays(todayStart, -6);
  const completed = actions.filter((record) =>
    record.status !== "running"
    && record.status !== "cancelled"
    && record.completedAtMs !== null
  );
  const improvements = completed
    .filter((record) => record.startedAtMs >= sevenDayStart && record.startedAtMs <= nowMs)
    .map((record) => {
      const observed = observedActionEffects(points, record);
      const metrics: ObservedImprovement["metrics"] = [];
      if (observed.cpu.effect === "improved") metrics.push("cpu");
      if (observed.memory.effect === "improved") metrics.push("memory");
      return { record, metrics };
    })
    .filter(({ metrics }) => metrics.length > 0)
    .sort((left, right) => right.record.startedAtMs - left.record.startedAtMs);
  const dataDayCount = new Set(
    points
      .filter(({ timestamp }) => timestamp >= sevenDayStart && timestamp <= nowMs)
      .map(({ timestamp }) => startOfLocalDay(timestamp)),
  ).size;

  return {
    today: summarizePeriod(
      todayStart,
      nowMs,
      points,
      alerts,
      networkQualityPoints,
      completed,
      improvements,
    ),
    yesterday: summarizePeriod(
      yesterdayStart,
      todayStart - 1,
      points,
      alerts,
      networkQualityPoints,
      completed,
      improvements,
    ),
    sevenDays: summarizePeriod(
      sevenDayStart,
      nowMs,
      points,
      alerts,
      networkQualityPoints,
      completed,
      improvements,
    ),
    sevenDayDailyAverageAnomalies: countAnomalies(
      alerts,
      networkQualityPoints,
      sevenDayStart,
      nowMs,
    ) / Math.max(1, dataDayCount),
    improvements,
    completedActionKinds: [...new Set(
      completed
        .filter(({ startedAtMs }) => startedAtMs >= sevenDayStart && startedAtMs <= nowMs)
        .map(({ kind }) => kind),
    )],
    dataDayCount,
  };
}

export function observedImprovementEffect(
  effect: ActionObservedEffect,
): boolean {
  return effect === "improved";
}

function summarizePeriod(
  fromMs: number,
  toMs: number,
  points: readonly HistoryPoint[],
  alerts: readonly ResourceAlertEvent[],
  networkQualityPoints: readonly NetworkQualityHistoryPoint[],
  actions: readonly UserActionRecord[],
  improvements: readonly ObservedImprovement[],
): ReviewPeriodSummary {
  const periodPoints = points.filter(({ timestamp }) =>
    timestamp >= fromMs && timestamp <= toMs);
  return {
    fromMs,
    toMs,
    anomalyCount: countAnomalies(
      alerts,
      networkQualityPoints,
      fromMs,
      toMs,
    ),
    networkEventCount: countNetworkEvents(networkQualityPoints, fromMs, toMs),
    completedActionCount: actions.filter(({ startedAtMs }) =>
      startedAtMs >= fromMs && startedAtMs <= toMs).length,
    observedImprovementCount: improvements.filter(({ record }) =>
      record.startedAtMs >= fromMs && record.startedAtMs <= toMs).length,
    averageCpuPercent: average(periodPoints.map(({ cpuPercent }) => cpuPercent)),
    averageMemoryPercent: average(
      periodPoints.map(({ memoryPercent }) => memoryPercent),
    ),
  };
}

function countAnomalies(
  alerts: readonly ResourceAlertEvent[],
  networkQualityPoints: readonly NetworkQualityHistoryPoint[],
  fromMs: number,
  toMs: number,
): number {
  return alerts.filter((event) =>
    event.kind === "triggered"
    && event.timestamp >= fromMs
    && event.timestamp <= toMs).length
    + countNetworkEvents(networkQualityPoints, fromMs, toMs);
}

function countNetworkEvents(
  points: readonly NetworkQualityHistoryPoint[],
  fromMs: number,
  toMs: number,
): number {
  return points.reduce((count, point) =>
    count + point.events.filter((event) =>
      event.kind !== "sleep_gap"
      && event.atMs >= fromMs
      && event.atMs <= toMs).length, 0);
}

function average(values: readonly number[]): number | null {
  const finite = values.filter(Number.isFinite);
  return finite.length === 0
    ? null
    : finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function shiftLocalDays(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}
