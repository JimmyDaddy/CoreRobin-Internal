import { describe, expect, it } from "vitest";

import {
  addStartupImpactSample,
  completeStartupImpactMeasurement,
  createStartupImpactAccumulator,
} from "./startupImpact";
import {
  compareStartupImpact,
  startupActionsBeforeMeasurement,
} from "./components/StartupExplorer";
import type { UserActionRecord } from "./userActionHistory";

describe("startup impact measurement", () => {
  it("settles after three consecutive quiet samples", () => {
    const accumulator = createStartupImpactAccumulator(1_000);
    expect(addStartupImpactSample(accumulator, 6_000, 20, 0, []).settled).toBe(false);
    expect(addStartupImpactSample(accumulator, 11_000, 18, 0, []).settled).toBe(false);
    expect(addStartupImpactSample(accumulator, 16_000, 16, 0, []).settled).toBe(true);
    expect(completeStartupImpactMeasurement(accumulator, 16_000, true).settledAfterMs).toBe(15_000);
  });

  it("compares the latest startup with the prior median and rising applications", () => {
    const previous = [
      measurement(1_000, 20_000, 20),
      measurement(2_000, 30_000, 30),
      measurement(3_000, 40_000, 40),
    ];
    const latest = measurement(4_000, 50_000, 60);

    expect(compareStartupImpact(latest, previous)).toEqual({
      direction: "slower",
      settleDeltaPercent: 66.66666666666666,
      risingApplication: { name: "Editor", cpuDelta: 30 },
    });
  });

  it("keeps every startup change between measurements instead of implying one cause", () => {
    const previous = measurement(1_000, 1_000, 20);
    const latest = measurement(10_000, 1_000, 20);
    const records = [
      startupAction("one", 4_000),
      startupAction("two", 6_000),
      startupAction("old", 500),
    ];

    expect(
      startupActionsBeforeMeasurement(records, latest, previous)
        .map((record) => record.targetName),
    ).toEqual(["one", "two"]);
  });
});

function startupAction(name: string, startedAtMs: number): UserActionRecord {
  return {
    id: name,
    kind: "startup_disable",
    status: "succeeded",
    startedAtMs,
    completedAtMs: startedAtMs + 1,
    targetName: name,
    targetCount: 1,
    affectedBytes: 0,
    failedCount: 0,
    verification: "verified",
  };
}

function measurement(
  launchedAtMs: number,
  settledAfterMs: number,
  peakCpuPercent: number,
) {
  return {
    launchedAtMs,
    completedAtMs: launchedAtMs + settledAfterMs,
    durationMs: settledAfterMs,
    settledAfterMs,
    sampleCount: 4,
    peakCpuPercent,
    peakDiskBytesPerSecond: 0,
    applications: [{
      name: "Editor",
      peakCpuPercent,
      peakMemoryBytes: 1_024,
      peakDiskBytesPerSecond: 0,
    }],
  };
}
