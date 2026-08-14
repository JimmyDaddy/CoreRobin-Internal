import { describe, expect, it } from "vitest";

import {
  buildTodayReview,
  observedActionEffects,
} from "./todayReview";
import type { HistoryPoint } from "./types";
import type { UserActionRecord } from "./userActionHistory";

describe("today review", () => {
  it("describes an observed pressure drop without assigning causation", () => {
    const completedAtMs = 1_000_000;
    const action = actionRecord({ completedAtMs, startedAtMs: completedAtMs - 1 });
    const points = [
      point(completedAtMs - 120_000, 80, 70),
      point(completedAtMs - 60_000, 70, 70),
      point(completedAtMs + 60_000, 20, 40),
      point(completedAtMs + 120_000, 15, 35),
    ];

    expect(observedActionEffects(points, action)).toMatchObject({
      cpu: {
        effect: "improved",
        beforeAverage: 75,
        afterAverage: 17.5,
      },
      memory: {
        effect: "improved",
        beforeAverage: 70,
        afterAverage: 37.5,
      },
    });
  });

  it("does not infer immediate system pressure effects for unrelated actions", () => {
    expect(observedActionEffects([], actionRecord({
      kind: "cleanup_delete",
    }))).toMatchObject({
      cpu: { effect: "not_applicable" },
      memory: { effect: "not_applicable" },
    });
  });

  it("builds a local-day summary and excludes sleep gaps from network incidents", () => {
    const nowMs = new Date(2026, 6, 29, 18, 0, 0).getTime();
    const sampledAtMs = new Date(2026, 6, 29, 12, 0, 0).getTime();
    const review = buildTodayReview({
      nowMs,
      points: [point(sampledAtMs, 72, 64)],
      applicationImpactPoints: [{
        bucketStartMs: sampledAtMs,
        sampledAtMs,
        sampleCount: 1,
        applications: [{
          applicationId: "app:test",
          name: "Test App",
          sampleCount: 1,
          averageCpuPercent: 42,
          peakCpuPercent: 72,
          averageMemoryBytes: 1_024,
          peakMemoryBytes: 2_048,
          averageDiskBytesPerSecond: 0,
          peakDiskBytesPerSecond: 0,
        }],
      }],
      alerts: [{
        id: "cpu:1",
        timestamp: sampledAtMs,
        resource: "cpu",
        kind: "triggered",
        severity: "high",
        valuePercent: 82,
        thresholdPercent: 75,
        startedAtMs: sampledAtMs,
        durationMs: 60_000,
      }],
      networkQualityPoints: [{
        bucketStartMs: sampledAtMs,
        sampledAtMs,
        sampleCount: 1,
        status: "online",
        dnsLookupMs: 2,
        dnsSampleCount: 1,
        averageLatencyMs: 10,
        latencySampleCount: 1,
        jitterMs: 1,
        jitterSampleCount: 1,
        probeCount: 6,
        successfulProbeCount: 6,
        events: [
          { kind: "sleep_gap", atMs: sampledAtMs },
          { kind: "interface_change", atMs: sampledAtMs },
        ],
        networkSignatureHash: null,
        dnsStatus: "passed",
        directStatus: "passed",
      }],
      actions: [],
    });

    expect(review).toMatchObject({
      status: "active",
      eventCount: 1,
      activeCount: 1,
      networkEventCount: 1,
      leadingApplicationName: "Test App",
      peakCpuPercent: 72,
      peakMemoryPercent: 64,
    });
  });

  it("assigns an action to the day it completed rather than the day it started", () => {
    const nowMs = new Date(2026, 6, 29, 12, 0, 0).getTime();
    const startedAtMs = new Date(2026, 6, 28, 23, 59, 0).getTime();
    const completedAtMs = new Date(2026, 6, 29, 0, 1, 0).getTime();
    const review = buildTodayReview({
      nowMs,
      points: [],
      applicationImpactPoints: [],
      alerts: [],
      networkQualityPoints: [],
      actions: [actionRecord({ startedAtMs, completedAtMs, kind: "cleanup_delete" })],
    });

    expect(review.completedActionCount).toBe(1);
    expect(review.actionResults[0]?.record.completedAtMs).toBe(completedAtMs);
  });
});

function point(
  timestamp: number,
  cpuPercent: number,
  memoryPercent: number,
): HistoryPoint {
  return {
    timestamp,
    cpuPercent,
    memoryPercent,
    diskReadBytesPerSecond: 0,
    diskWriteBytesPerSecond: 0,
    networkReceivedBytesPerSecond: 0,
    networkTransmittedBytesPerSecond: 0,
  };
}

function actionRecord(
  overrides: Partial<UserActionRecord> = {},
): UserActionRecord {
  return {
    id: "action-1",
    kind: "process_close",
    status: "succeeded",
    verification: "verified",
    startedAtMs: 999_999,
    completedAtMs: 1_000_000,
    targetName: "Test App",
    targetCount: 1,
    affectedBytes: null,
    failedCount: 0,
    ...overrides,
  };
}
