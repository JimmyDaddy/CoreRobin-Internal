import { describe, expect, it } from "vitest";

import { buildWeeklyReview } from "./weeklyReview";
import type { HistoryPoint } from "./types";
import type { UserActionRecord } from "./userActionHistory";

const NOW = new Date(2026, 6, 30, 18).getTime();

function point(timestamp: number, cpuPercent: number): HistoryPoint {
  return {
    timestamp,
    cpuPercent,
    memoryPercent: cpuPercent,
    diskReadBytesPerSecond: 0,
    diskWriteBytesPerSecond: 0,
    networkReceivedBytesPerSecond: 0,
    networkTransmittedBytesPerSecond: 0,
  };
}

describe("weekly review", () => {
  it("keeps yesterday and seven-day evidence separate without a score", () => {
    const actionAt = NOW - 60 * 60 * 1_000;
    const points = [
      point(actionAt - 10 * 60_000, 80),
      point(actionAt - 5 * 60_000, 80),
      point(actionAt + 5 * 60_000, 20),
      point(actionAt + 10 * 60_000, 20),
      point(NOW - 24 * 60 * 60_000, 40),
    ];
    const action: UserActionRecord = {
      id: "action",
      kind: "process_close",
      status: "succeeded",
      verification: "verified",
      startedAtMs: actionAt,
      completedAtMs: actionAt,
      targetName: "Example",
      targetCount: 1,
      affectedBytes: null,
      failedCount: null,
    };
    const review = buildWeeklyReview({
      points,
      alerts: [{
        id: "alert",
        timestamp: NOW - 2_000,
        resource: "cpu",
        kind: "triggered",
        severity: "high",
        valuePercent: 80,
        thresholdPercent: 65,
        startedAtMs: NOW - 12_000,
        durationMs: 10_000,
      }],
      networkQualityPoints: [],
      actions: [action],
      nowMs: NOW,
    });

    expect(review.today.anomalyCount).toBe(1);
    expect(review.yesterday.anomalyCount).toBe(0);
    expect(review.sevenDays.completedActionCount).toBe(1);
    expect(review.improvements[0]?.metrics).toEqual(["cpu", "memory"]);
    expect(review).not.toHaveProperty("score");
  });

  it("does not count sleep gaps as network anomalies", () => {
    const review = buildWeeklyReview({
      points: [],
      alerts: [],
      actions: [],
      networkQualityPoints: [{
        bucketStartMs: NOW - 1_000,
        sampledAtMs: NOW - 1_000,
        sampleCount: 1,
        status: "online",
        dnsLookupMs: 5,
        dnsSampleCount: 1,
        averageLatencyMs: 8,
        latencySampleCount: 1,
        jitterMs: 1,
        jitterSampleCount: 1,
        probeCount: 6,
        successfulProbeCount: 6,
        events: [{ kind: "sleep_gap", atMs: NOW - 1_000 }],
        networkSignatureHash: null,
        dnsStatus: "passed",
        directStatus: "passed",
      }],
      nowMs: NOW,
    });
    expect(review.today.anomalyCount).toBe(0);
  });
});
