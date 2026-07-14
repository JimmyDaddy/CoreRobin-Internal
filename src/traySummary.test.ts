import { describe, expect, it } from "vitest";

import { getMockSnapshot } from "./mockData";
import { buildTraySummary } from "./traySummary";

describe("buildTraySummary", () => {
  it("creates a compact snapshot from system data", () => {
    const summary = buildTraySummary(getMockSnapshot(), false, [35, 65, 85]);

    expect(summary.memoryPercent).toBeGreaterThan(0);
    expect(summary.storageAvailableBytes).toBeGreaterThan(0);
    expect(summary.batteryPercent).toBe(78);
  });

  it("raises urgent health for critical memory pressure", () => {
    const snapshot = getMockSnapshot();
    snapshot.memory.usedBytes = snapshot.memory.totalBytes * 0.96;
    snapshot.memory.availableBytes = snapshot.memory.totalBytes * 0.04;

    const summary = buildTraySummary(snapshot, false, [35, 65, 85]);

    expect(summary.health).toBe("urgent");
    expect(summary.reason).toBe("memory");
  });
});
