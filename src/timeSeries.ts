export type TimeSeriesRangeHours = 1 | 24 | 168;

export interface TimeSeriesPoint {
  timestamp: number;
  values: Array<number | null>;
  sampleCount?: number;
}

export interface TimeSeriesCompleteness {
  observedBuckets: number;
  expectedBuckets: number;
  percent: number;
}

export function timeSeriesBucketMs(rangeHours: TimeSeriesRangeHours): number {
  if (rangeHours === 1) return 5 * 60 * 1_000;
  if (rangeHours === 24) return 15 * 60 * 1_000;
  return 60 * 60 * 1_000;
}

export function downsampleTimeSeries(
  points: readonly TimeSeriesPoint[],
  rangeHours: TimeSeriesRangeHours,
  now = Date.now(),
): TimeSeriesPoint[] {
  const bucketMs = timeSeriesBucketMs(rangeHours);
  const start = now - rangeHours * 60 * 60 * 1_000;
  const buckets = new Map<
    number,
    { sums: number[]; counts: number[]; sampleCount: number }
  >();

  for (const point of points) {
    if (
      !Number.isFinite(point.timestamp)
      || point.timestamp < start
      || point.timestamp > now
    ) {
      continue;
    }
    const bucketStart = Math.floor(point.timestamp / bucketMs) * bucketMs;
    const bucket = buckets.get(bucketStart) ?? {
      sums: Array.from({ length: point.values.length }, () => 0),
      counts: Array.from({ length: point.values.length }, () => 0),
      sampleCount: 0,
    };
    point.values.forEach((value, index) => {
      if (value === null || !Number.isFinite(value)) return;
      bucket.sums[index] = (bucket.sums[index] ?? 0) + value;
      bucket.counts[index] = (bucket.counts[index] ?? 0) + 1;
    });
    bucket.sampleCount += point.sampleCount ?? 1;
    buckets.set(bucketStart, bucket);
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([timestamp, bucket]) => ({
      timestamp,
      values: bucket.sums.map((sum, index) => {
        const count = bucket.counts[index] ?? 0;
        return count > 0 ? sum / count : null;
      }),
      sampleCount: bucket.sampleCount,
    }));
}

export function splitTimeSeriesSegments(
  points: readonly TimeSeriesPoint[],
  seriesIndex: number,
  gapThresholdMs: number,
): TimeSeriesPoint[][] {
  const ordered = [...points].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  const segments: TimeSeriesPoint[][] = [];
  let current: TimeSeriesPoint[] = [];

  for (const point of ordered) {
    const value = point.values[seriesIndex];
    const previous = current[current.length - 1];
    if (
      value === null
      || value === undefined
      || !Number.isFinite(value)
      || (previous && point.timestamp - previous.timestamp > gapThresholdMs)
    ) {
      if (current.length > 0) segments.push(current);
      current = [];
      if (value === null || value === undefined || !Number.isFinite(value)) {
        continue;
      }
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

export function timeSeriesCompleteness(
  points: readonly TimeSeriesPoint[],
  startAtMs: number,
  endAtMs: number,
  expectedIntervalMs: number,
): TimeSeriesCompleteness {
  const safeInterval = Math.max(1, expectedIntervalMs);
  const expectedBuckets = Math.max(
    1,
    Math.ceil(Math.max(1, endAtMs - startAtMs) / safeInterval),
  );
  const observedBuckets = new Set(
    points
      .filter(({ timestamp }) => timestamp >= startAtMs && timestamp <= endAtMs)
      .map(({ timestamp }) => Math.floor(timestamp / safeInterval)),
  ).size;
  return {
    observedBuckets,
    expectedBuckets,
    percent: Math.min(100, observedBuckets / expectedBuckets * 100),
  };
}
