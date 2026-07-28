import { describe, expect, it } from "vitest";

import { buildPersonalBaseline } from "./personalBaseline";
import type { HistoryPoint } from "./types";

describe("personal baseline", () => {
  it("compares recent activity with the same time of day without a health score", () => {
    const now = new Date("2026-07-28T12:00:00Z").getTime();
    const baseline = Array.from({ length: 12 }, (_, index) =>
      historyPoint(
        now - (index % 6 + 1) * 24 * 60 * 60 * 1_000 - Math.floor(index / 6) * 60_000,
        20,
        50,
      )
    );
    const recent = [
      historyPoint(now - 10 * 60_000, 60, 52),
      historyPoint(now - 5 * 60_000, 60, 52),
    ];

    const comparisons = buildPersonalBaseline([...baseline, ...recent], now);

    expect(comparisons.find(({ metric }) => metric === "cpu")).toMatchObject({
      status: "elevated",
      current: 60,
      baseline: 20,
      changePercent: 200,
      sampleCount: 12,
    });
    expect(comparisons.find(({ metric }) => metric === "memory")?.status)
      .toBe("typical");
  });

  it("keeps metrics in learning state until enough comparable samples exist", () => {
    const now = 10_000_000;
    const comparisons = buildPersonalBaseline(
      [historyPoint(now - 1_000, 30, 40)],
      now,
    );

    expect(comparisons.every(({ status }) => status === "learning")).toBe(true);
  });
});

function historyPoint(
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
    temperatureCelsius: 40,
    batteryDrainPercentPerHour: 0,
  };
}
