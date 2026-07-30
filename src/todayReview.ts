import {
  summarizeApplicationImpactHistory,
  type ApplicationImpactHistoryPoint,
} from "./applicationImpactHistory";
import { buildHistoryStories } from "./historyStories";
import type { NetworkQualityHistoryPoint } from "./networkQualityHistory";
import type { ResourceAlertEvent } from "./resourceAlerts";
import type { HistoryPoint } from "./types";
import type { UserActionRecord } from "./userActionHistory";

export type ActionObservedEffect =
  | "improved"
  | "increased"
  | "stable"
  | "insufficient"
  | "not_applicable";

export type TodayReviewStatus = "active" | "settled" | "handled" | "calm";

export interface TodayActionResult {
  record: UserActionRecord;
  cpuEffect: ObservedMetricEffect;
  memoryEffect: ObservedMetricEffect;
}

export interface ObservedMetricEffect {
  effect: ActionObservedEffect;
  beforeAverage: number | null;
  afterAverage: number | null;
}

export interface TodayReviewSummary {
  status: TodayReviewStatus;
  eventCount: number;
  resolvedCount: number;
  activeCount: number;
  completedActionCount: number;
  networkEventCount: number;
  peakCpuPercent: number;
  peakMemoryPercent: number;
  leadingApplicationName: string | null;
  actionResults: TodayActionResult[];
}

export function buildTodayReview({
  points,
  applicationImpactPoints,
  alerts,
  networkQualityPoints,
  actions,
  nowMs = Date.now(),
}: {
  points: readonly HistoryPoint[];
  applicationImpactPoints: readonly ApplicationImpactHistoryPoint[];
  alerts: readonly ResourceAlertEvent[];
  networkQualityPoints: readonly NetworkQualityHistoryPoint[];
  actions: readonly UserActionRecord[];
  nowMs?: number;
}): TodayReviewSummary {
  const fromMs = startOfLocalDay(nowMs);
  const todayPoints = points.filter(({ timestamp }) =>
    timestamp >= fromMs && timestamp <= nowMs);
  const stories = buildHistoryStories(alerts).filter((story) =>
    story.startedAtMs >= fromMs
    || (story.endedAtMs !== null && story.endedAtMs >= fromMs));
  const activeCount = stories.filter(({ status }) => status === "active").length;
  const resolvedCount = stories.filter(({ status }) => status === "recovered").length;
  const completedActions = actions
    .filter((action) =>
      action.startedAtMs >= fromMs
      && action.startedAtMs <= nowMs
      && action.status !== "running")
    .sort((left, right) => right.startedAtMs - left.startedAtMs);
  const networkEventCount = networkQualityPoints.reduce(
    (count, point) => count + point.events.filter((event) =>
      event.atMs >= fromMs
      && event.atMs <= nowMs
      && event.kind !== "sleep_gap").length,
    0,
  );
  const leadingApplication = summarizeApplicationImpactHistory(
    applicationImpactPoints.filter(({ sampledAtMs }) =>
      sampledAtMs >= fromMs && sampledAtMs <= nowMs),
  )[0] ?? null;

  return {
    status: activeCount > 0
      ? "active"
      : stories.length > 0 || networkEventCount > 0
        ? "settled"
        : completedActions.length > 0
          ? "handled"
          : "calm",
    eventCount: stories.length,
    resolvedCount,
    activeCount,
    completedActionCount: completedActions.length,
    networkEventCount,
    peakCpuPercent: maximum(todayPoints.map(({ cpuPercent }) => cpuPercent)),
    peakMemoryPercent: maximum(
      todayPoints.map(({ memoryPercent }) => memoryPercent),
    ),
    leadingApplicationName: leadingApplication?.name ?? null,
    actionResults: completedActions.slice(0, 4).map((record) => {
      const observed = observedActionEffects(points, record);
      return {
        record,
        cpuEffect: observed.cpu,
        memoryEffect: observed.memory,
      };
    }),
  };
}

export function observedActionEffects(
  points: readonly HistoryPoint[],
  action: UserActionRecord,
): { cpu: ObservedMetricEffect; memory: ObservedMetricEffect } {
  const notApplicable: ObservedMetricEffect = {
    effect: "not_applicable",
    beforeAverage: null,
    afterAverage: null,
  };
  if (
    action.status !== "succeeded"
    && action.status !== "partial"
  ) {
    return { cpu: notApplicable, memory: notApplicable };
  }
  if (
    action.kind !== "process_close"
    && action.kind !== "process_restart"
    && action.kind !== "process_force_quit"
  ) {
    return { cpu: notApplicable, memory: notApplicable };
  }
  const completedAtMs = action.completedAtMs ?? action.startedAtMs;
  const windowMs = 15 * 60 * 1_000;
  const before = points.filter((point) =>
    point.timestamp >= completedAtMs - windowMs
    && point.timestamp < completedAtMs);
  const after = points.filter((point) =>
    point.timestamp > completedAtMs
    && point.timestamp <= completedAtMs + windowMs);
  if (before.length < 2 || after.length < 2) {
    const insufficient: ObservedMetricEffect = {
      effect: "insufficient",
      beforeAverage: null,
      afterAverage: null,
    };
    return { cpu: insufficient, memory: insufficient };
  }
  return {
    cpu: metricEffect(before, after, (point) => point.cpuPercent),
    memory: metricEffect(before, after, (point) => point.memoryPercent),
  };
}

export function observedActionEffect(
  points: readonly HistoryPoint[],
  action: UserActionRecord,
): ActionObservedEffect {
  const { cpu, memory } = observedActionEffects(points, action);
  if (cpu.effect === "not_applicable") return "not_applicable";
  if (cpu.effect === "insufficient" || memory.effect === "insufficient") {
    return "insufficient";
  }
  if (cpu.effect === "increased" || memory.effect === "increased") {
    return "increased";
  }
  if (cpu.effect === "improved" || memory.effect === "improved") {
    return "improved";
  }
  return "stable";
}

function metricEffect(
  before: readonly HistoryPoint[],
  after: readonly HistoryPoint[],
  value: (point: HistoryPoint) => number,
): ObservedMetricEffect {
  const beforeAverage = average(before.map(value));
  const afterAverage = average(after.map(value));
  const delta = afterAverage - beforeAverage;
  return {
    effect: delta <= -5 ? "improved" : delta >= 5 ? "increased" : "stable",
    beforeAverage,
    afterAverage,
  };
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function maximum(values: readonly number[]): number {
  return Math.max(0, ...values.filter(Number.isFinite));
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
