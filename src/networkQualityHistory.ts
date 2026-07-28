import type { NetworkQualityResult, NetworkQualityStatus } from "./types";

export const NETWORK_QUALITY_HISTORY_STORAGE_KEY =
  "core-robin.network-quality-history.v1";
export const NETWORK_QUALITY_HISTORY_BUCKET_MS = 5 * 60 * 1_000;

export type NetworkQualityHistoryHours = 1 | 24;

export interface NetworkQualityHistoryPoint {
  bucketStartMs: number;
  sampledAtMs: number;
  sampleCount: number;
  status: NetworkQualityStatus;
  dnsLookupMs: number | null;
  dnsSampleCount: number;
  averageLatencyMs: number | null;
  latencySampleCount: number;
  jitterMs: number | null;
  jitterSampleCount: number;
  probeCount: number;
  successfulProbeCount: number;
}

export function loadNetworkQualityHistory(
  storage: Storage = window.localStorage,
): NetworkQualityHistoryPoint[] {
  try {
    const value = JSON.parse(
      storage.getItem(NETWORK_QUALITY_HISTORY_STORAGE_KEY) ?? "[]",
    ) as unknown;
    return Array.isArray(value)
      ? value.filter(isNetworkQualityHistoryPoint)
      : [];
  } catch {
    return [];
  }
}

export function saveNetworkQualityHistory(
  points: readonly NetworkQualityHistoryPoint[],
  storage: Storage = window.localStorage,
): void {
  try {
    storage.setItem(
      NETWORK_QUALITY_HISTORY_STORAGE_KEY,
      JSON.stringify(points),
    );
  } catch {
    // The live network-quality result remains usable without persistence.
  }
}

export function clearNetworkQualityHistory(
  storage: Storage = window.localStorage,
): void {
  try {
    storage.removeItem(NETWORK_QUALITY_HISTORY_STORAGE_KEY);
  } catch {
    // Nothing else is required when storage is unavailable.
  }
}

export function mergeNetworkQualityHistory(
  current: readonly NetworkQualityHistoryPoint[],
  sample: NetworkQualityResult,
  retentionHours: NetworkQualityHistoryHours,
  now = sample.sampledAtMs,
): NetworkQualityHistoryPoint[] {
  const cutoff = now - retentionHours * 60 * 60 * 1_000;
  const bucketStartMs =
    Math.floor(sample.sampledAtMs / NETWORK_QUALITY_HISTORY_BUCKET_MS)
    * NETWORK_QUALITY_HISTORY_BUCKET_MS;
  const buckets = new Map(
    current
      .filter((point) => point.sampledAtMs >= cutoff)
      .map((point) => [point.bucketStartMs, point]),
  );
  const previous = buckets.get(bucketStartMs);
  buckets.set(bucketStartMs, previous
    ? mergeBucket(previous, sample)
    : pointFromSample(sample, bucketStartMs));
  return [...buckets.values()]
    .sort((left, right) => left.bucketStartMs - right.bucketStartMs)
    .filter((point) => point.sampledAtMs >= cutoff);
}

export function networkQualityFailurePercent(
  point: Pick<NetworkQualityHistoryPoint, "probeCount" | "successfulProbeCount">,
): number {
  if (point.probeCount <= 0) return 0;
  return Math.max(
    0,
    (point.probeCount - point.successfulProbeCount) / point.probeCount * 100,
  );
}

function pointFromSample(
  sample: NetworkQualityResult,
  bucketStartMs: number,
): NetworkQualityHistoryPoint {
  return {
    bucketStartMs,
    sampledAtMs: sample.sampledAtMs,
    sampleCount: 1,
    status: sample.status,
    dnsLookupMs: sample.dnsLookupMs,
    dnsSampleCount: sample.dnsLookupMs === null ? 0 : 1,
    averageLatencyMs: sample.averageLatencyMs,
    latencySampleCount: sample.averageLatencyMs === null ? 0 : 1,
    jitterMs: sample.jitterMs,
    jitterSampleCount: sample.jitterMs === null ? 0 : 1,
    probeCount: sample.probeCount,
    successfulProbeCount: sample.successfulProbeCount,
  };
}

function mergeBucket(
  previous: NetworkQualityHistoryPoint,
  sample: NetworkQualityResult,
): NetworkQualityHistoryPoint {
  return {
    ...previous,
    sampledAtMs: Math.max(previous.sampledAtMs, sample.sampledAtMs),
    sampleCount: previous.sampleCount + 1,
    status: worseStatus(previous.status, sample.status),
    dnsLookupMs: mergeAverage(
      previous.dnsLookupMs,
      previous.dnsSampleCount,
      sample.dnsLookupMs,
    ),
    dnsSampleCount:
      previous.dnsSampleCount + (sample.dnsLookupMs === null ? 0 : 1),
    averageLatencyMs: mergeAverage(
      previous.averageLatencyMs,
      previous.latencySampleCount,
      sample.averageLatencyMs,
    ),
    latencySampleCount:
      previous.latencySampleCount + (sample.averageLatencyMs === null ? 0 : 1),
    jitterMs: mergeAverage(
      previous.jitterMs,
      previous.jitterSampleCount,
      sample.jitterMs,
    ),
    jitterSampleCount:
      previous.jitterSampleCount + (sample.jitterMs === null ? 0 : 1),
    probeCount: previous.probeCount + sample.probeCount,
    successfulProbeCount:
      previous.successfulProbeCount + sample.successfulProbeCount,
  };
}

function mergeAverage(
  previous: number | null,
  previousCount: number,
  next: number | null,
): number | null {
  if (previous === null) return next;
  if (next === null) return previous;
  return (previous * previousCount + next) / (previousCount + 1);
}

function worseStatus(
  left: NetworkQualityStatus,
  right: NetworkQualityStatus,
): NetworkQualityStatus {
  const order: Record<NetworkQualityStatus, number> = {
    online: 0,
    limited: 1,
    offline: 2,
  };
  return order[left] >= order[right] ? left : right;
}

function isNetworkQualityHistoryPoint(
  value: unknown,
): value is NetworkQualityHistoryPoint {
  if (!value || typeof value !== "object") return false;
  const point = value as Partial<NetworkQualityHistoryPoint>;
  return (
    finite(point.bucketStartMs)
    && finite(point.sampledAtMs)
    && finite(point.sampleCount)
    && (point.status === "online"
      || point.status === "limited"
      || point.status === "offline")
    && nullableFinite(point.dnsLookupMs)
    && finite(point.dnsSampleCount)
    && nullableFinite(point.averageLatencyMs)
    && finite(point.latencySampleCount)
    && nullableFinite(point.jitterMs)
    && finite(point.jitterSampleCount)
    && finite(point.probeCount)
    && finite(point.successfulProbeCount)
  );
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nullableFinite(value: unknown): value is number | null {
  return value === null || finite(value);
}
