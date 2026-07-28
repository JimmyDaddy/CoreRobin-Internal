import type { HistoryPoint } from "./types";

export type PersonalBaselineMetric =
  | "cpu"
  | "memory"
  | "disk"
  | "network"
  | "temperature"
  | "battery";
export type PersonalBaselineStatus = "learning" | "typical" | "elevated";
export type PersonalBaselineConfidence = "learning" | "limited" | "established";

export interface PersonalBaselineComparison {
  metric: PersonalBaselineMetric;
  status: PersonalBaselineStatus;
  current: number | null;
  baseline: number | null;
  changePercent: number | null;
  sampleCount: number;
  distinctDayCount: number;
  confidence: PersonalBaselineConfidence;
}

const MINIMUM_BASELINE_POINTS = 12;
const MINIMUM_BASELINE_DAYS = 3;
const RECENT_WINDOW_MS = 15 * 60 * 1_000;
const BASELINE_MIN_AGE_MS = 60 * 60 * 1_000;
const BASELINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export function buildPersonalBaseline(
  points: readonly HistoryPoint[],
  now = Date.now(),
): PersonalBaselineComparison[] {
  const recent = points.filter((point) =>
    point.timestamp >= now - RECENT_WINDOW_MS && point.timestamp <= now
  );
  const currentHour = new Date(now).getHours();
  const currentDayType = dayType(now);
  const baseline = points.filter((point) => {
    const age = now - point.timestamp;
    if (age < BASELINE_MIN_AGE_MS || age > BASELINE_MAX_AGE_MS) return false;
    const hour = new Date(point.timestamp).getHours();
    const distance = Math.min(
      Math.abs(hour - currentHour),
      24 - Math.abs(hour - currentHour),
    );
    return distance <= 1 && dayType(point.timestamp) === currentDayType;
  });
  return ([
    "cpu",
    "memory",
    "disk",
    "network",
    "temperature",
    "battery",
  ] as const).map((metric) =>
    compareMetric(metric, recent, baseline)
  );
}

function compareMetric(
  metric: PersonalBaselineMetric,
  recent: readonly HistoryPoint[],
  baseline: readonly HistoryPoint[],
): PersonalBaselineComparison {
  const currentValues = recent
    .map((point) => metricValue(point, metric))
    .filter((value): value is number => value !== null);
  const baselineValues = baseline
    .map((point) => metricValue(point, metric))
    .filter((value): value is number => value !== null);
  const current = average(currentValues);
  const typical = median(baselineValues);
  const distinctDayCount = new Set(
    baseline
      .filter((point) => metricValue(point, metric) !== null)
      .map((point) => localDayKey(point.timestamp)),
  ).size;
  const confidence: PersonalBaselineConfidence =
    baselineValues.length >= 36 && distinctDayCount >= 5
      ? "established"
      : baselineValues.length >= MINIMUM_BASELINE_POINTS
        && distinctDayCount >= MINIMUM_BASELINE_DAYS
        ? "limited"
        : "learning";
  if (
    current === null
    || typical === null
    || baselineValues.length < MINIMUM_BASELINE_POINTS
    || distinctDayCount < MINIMUM_BASELINE_DAYS
  ) {
    return {
      metric,
      status: "learning",
      current,
      baseline: typical,
      changePercent: null,
      sampleCount: baselineValues.length,
      distinctDayCount,
      confidence,
    };
  }
  const changePercent = typical <= 0
    ? current <= 0 ? 0 : null
    : ((current - typical) / typical) * 100;
  return {
    metric,
    status: isElevated(
      metric,
      current,
      typical,
      medianAbsoluteDeviation(baselineValues, typical),
      changePercent,
    )
      ? "elevated"
      : "typical",
    current,
    baseline: typical,
    changePercent,
    sampleCount: baselineValues.length,
    distinctDayCount,
    confidence,
  };
}

function metricValue(
  point: HistoryPoint,
  metric: PersonalBaselineMetric,
): number | null {
  if (metric === "cpu") return point.cpuPercent;
  if (metric === "memory") return point.memoryPercent;
  if (metric === "temperature") return point.temperatureCelsius ?? null;
  if (metric === "battery") return point.batteryDrainPercentPerHour ?? null;
  if (metric === "disk") {
    if (
      point.diskReadBytesPerSecond === null
      || point.diskWriteBytesPerSecond === null
    ) return null;
    return point.diskReadBytesPerSecond + point.diskWriteBytesPerSecond;
  }
  if (
    point.networkReceivedBytesPerSecond === null
    || point.networkTransmittedBytesPerSecond === null
  ) return null;
  return point.networkReceivedBytesPerSecond
    + point.networkTransmittedBytesPerSecond;
}

function isElevated(
  metric: PersonalBaselineMetric,
  current: number,
  baseline: number,
  baselineDeviation: number,
  changePercent: number | null,
): boolean {
  const relativeThreshold = metric === "temperature" ? 15 : 50;
  if (changePercent === null || changePercent < relativeThreshold) return false;
  const meaningfulDelta =
    metric === "cpu" || metric === "memory"
      ? 10
      : metric === "temperature"
        ? 8
        : metric === "battery"
          ? 2
          : 2 * 1_024 * 1_024;
  return current - baseline >= Math.max(meaningfulDelta, baselineDeviation * 3);
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
}

function medianAbsoluteDeviation(
  values: readonly number[],
  center: number,
): number {
  return median(values.map((value) => Math.abs(value - center))) ?? 0;
}

function dayType(timestamp: number): "weekday" | "weekend" {
  const day = new Date(timestamp).getDay();
  return day === 0 || day === 6 ? "weekend" : "weekday";
}

function localDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
