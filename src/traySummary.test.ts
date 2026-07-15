import { describe, expect, it } from "vitest";

import { getMockSnapshot } from "./mockData";
import { analyzeSystemHealth } from "./diagnosis";
import { buildTraySummary } from "./traySummary";

describe("buildTraySummary", () => {
  it("creates a compact snapshot from system data", () => {
    const snapshot = getMockSnapshot();
    const diagnosis = analyzeSystemHealth({ snapshot, history: [], connections: null });
    const summary = buildTraySummary(snapshot, false, diagnosis);

    expect(summary.memoryPercent).toBeGreaterThan(0);
    expect(summary.storageAvailableBytes).toBeGreaterThan(0);
    expect(summary.batteryPercent).toBe(78);
  });

  it("raises urgent health for critical memory pressure", () => {
    const snapshot = getMockSnapshot();
    snapshot.memory.usedBytes = snapshot.memory.totalBytes * 0.96;
    snapshot.memory.availableBytes = snapshot.memory.totalBytes * 0.02;
    snapshot.memory.swapUsedBytes = 2 * 1_024 ** 3;
    const diagnosis = analyzeSystemHealth({ snapshot, history: [], connections: null });

    const summary = buildTraySummary(snapshot, false, diagnosis);

    expect(summary.health).toBe("urgent");
    expect(summary.reason).toBe("memory");
  });

  it("does not contradict the everyday diagnosis on a brief CPU spike", () => {
    const snapshot = getMockSnapshot();
    snapshot.cpu.usagePercent = 99;
    snapshot.disk.volumes = snapshot.disk.volumes.map((volume) => ({
      ...volume,
      availableBytes: volume.totalBytes * 0.5,
    }));
    snapshot.sensors.sleep.blockers = [];
    snapshot.sensors.temperature.celsius = 55;
    snapshot.sensors.battery = {
      ...snapshot.sensors.battery,
      present: true,
      chargePercent: 80,
      state: "discharging",
    };
    const diagnosis = analyzeSystemHealth({ snapshot, history: [], connections: null });

    const summary = buildTraySummary(snapshot, false, diagnosis);

    expect(diagnosis.status).toBe("observing");
    expect(summary.health).toBe("observing");
    expect(summary.reason).toBe("none");
  });
});
