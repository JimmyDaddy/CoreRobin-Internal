import { describe, expect, it } from "vitest";

import { runtimeEnergyScenarios, summarizeEnergySamples } from "./runtime-energy-baseline.mjs";

describe("runtime energy baseline", () => {
  it("keeps the foreground, hidden, and tray scenarios explicit", () => {
    expect(runtimeEnergyScenarios.map(({ id }) => id)).toEqual(["foreground", "hidden", "tray"]);
  });

  it("summarizes only the requested process", () => {
    const summary = summarizeEnergySamples([
      {
        tasks: [
          {
            pid: 42,
            cputime_ms_per_s: 20,
            intr_wakeups_per_s: 4,
            idle_wakeups_per_s: 1,
            energy_impact: 0.5,
          },
          { pid: 7, cputime_ms_per_s: 900, intr_wakeups_per_s: 500 },
        ],
      },
      {
        tasks: [
          {
            pid: 42,
            cputime_ms_per_s: 40,
            intr_wakeups_per_s: 6,
            idle_wakeups_per_s: 3,
            energy_impact: 1.5,
          },
        ],
      },
    ], 42, [
      { cpuPercent: 1, rssBytes: 100 },
      { cpuPercent: 3, rssBytes: 300 },
    ]);

    expect(summary.cpuPercent?.average).toBe(3);
    expect(summary.interruptWakeupsPerSecond?.average).toBe(5);
    expect(summary.packageIdleWakeupsPerSecond?.average).toBe(2);
    expect(summary.residentMemoryBytes?.average).toBe(200);
    expect(summary.energyImpact?.p95).toBe(1.5);
  });
});
