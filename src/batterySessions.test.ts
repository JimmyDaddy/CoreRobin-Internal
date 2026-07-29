import { describe, expect, it } from "vitest";

import { buildBatteryUsageSessions } from "./batterySessions";
import type { HistoryPoint } from "./types";

describe("battery usage sessions", () => {
  it("starts on battery power and explains drain and blockers", () => {
    const points = [
      point(1_000, "ac", 90),
      point(301_000, "battery", 88, "Browser", ["syncd"]),
      point(601_000, "battery", 86, "Browser", ["syncd"]),
      point(901_000, "ac", 86),
    ];
    const sessions = buildBatteryUsageSessions(points, 2_000_000);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      startChargePercent: 88,
      endChargePercent: 86,
      drainPercent: 2,
      blockerNames: ["syncd"],
      majorApplicationNames: ["Browser"],
    });
  });
});

function point(
  timestamp: number,
  batteryPowerSource: "ac" | "battery",
  batteryChargePercent: number,
  topApplicationName: string | null = null,
  sleepBlockerNames: string[] = [],
): HistoryPoint {
  return {
    timestamp,
    cpuPercent: 10,
    memoryPercent: 20,
    diskReadBytesPerSecond: 0,
    diskWriteBytesPerSecond: 0,
    networkReceivedBytesPerSecond: 0,
    networkTransmittedBytesPerSecond: 0,
    batteryPowerSource,
    batteryChargePercent,
    topApplicationName,
    sleepBlockerNames,
  };
}
