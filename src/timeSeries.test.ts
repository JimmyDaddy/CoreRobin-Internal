import { describe, expect, it } from "vitest";

import {
  downsampleTimeSeries,
  splitTimeSeriesSegments,
  timeSeriesBucketMs,
  timeSeriesCompleteness,
} from "./timeSeries";

describe("timeSeries", () => {
  it("uses different display resolutions for each range", () => {
    expect(timeSeriesBucketMs(1)).toBe(5 * 60_000);
    expect(timeSeriesBucketMs(24)).toBe(15 * 60_000);
    expect(timeSeriesBucketMs(168)).toBe(60 * 60_000);
  });

  it("downsamples using real time buckets", () => {
    const now = 3_660_000;
    expect(downsampleTimeSeries([
      { timestamp: 3_600_000, values: [10, 20] },
      { timestamp: 3_630_000, values: [30, null] },
    ], 24, now)).toEqual([
      {
        timestamp: 3_600_000,
        values: [20, 20],
        sampleCount: 2,
      },
    ]);
  });

  it("creates a visible gap after sampling stops", () => {
    const points = [
      { timestamp: 0, values: [1] },
      { timestamp: 1_000, values: [2] },
      { timestamp: 20_000, values: [3] },
    ];
    expect(splitTimeSeriesSegments(points, 0, 5_000)).toEqual([
      points.slice(0, 2),
      points.slice(2),
    ]);
  });

  it("reports observed time buckets instead of point count", () => {
    expect(timeSeriesCompleteness([
      { timestamp: 500, values: [1] },
      { timestamp: 900, values: [2] },
      { timestamp: 2_100, values: [3] },
    ], 0, 4_000, 1_000)).toEqual({
      observedBuckets: 2,
      expectedBuckets: 4,
      percent: 50,
    });
  });
});
