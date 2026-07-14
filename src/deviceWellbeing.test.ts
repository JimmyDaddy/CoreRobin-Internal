import { describe, expect, it } from "vitest";

import {
  batteryWellbeingLevel,
  sleepWellbeingLevel,
  summarizeSleepBlockers,
  temperatureWellbeingLevel,
} from "./deviceWellbeing";
import type { ApplicationImpact } from "./diagnosis";

describe("device wellbeing", () => {
  it("uses reported critical temperature without alarming on normal warmth", () => {
    expect(temperatureWellbeingLevel({ celsius: 62, componentLabel: "CPU", criticalCelsius: 100 })).toBe("normal");
    expect(temperatureWellbeingLevel({ celsius: 78, componentLabel: "CPU", criticalCelsius: 100 })).toBe("attention");
    expect(temperatureWellbeingLevel({ celsius: 91, componentLabel: "CPU", criticalCelsius: 100 })).toBe("urgent");
  });

  it("only warns for a low battery while discharging", () => {
    expect(batteryWellbeingLevel({ present: true, chargePercent: 8, state: "charging", timeRemainingMinutes: null, powerSource: "ac" })).toBe("normal");
    expect(batteryWellbeingLevel({ present: true, chargePercent: 8, state: "discharging", timeRemainingMinutes: 22, powerSource: "battery" })).toBe("urgent");
    expect(batteryWellbeingLevel({ present: false, chargePercent: null, state: "unknown", timeRemainingMinutes: null, powerSource: "unknown" })).toBe("unavailable");
  });

  it("maps sleep assertions back to familiar application names", () => {
    const application: ApplicationImpact = {
      id: "developer:code",
      name: "Visual Studio Code",
      processCount: 2,
      cpuPercent: 4,
      memoryBytes: 100,
      diskBytesPerSecond: 0,
      systemComponent: false,
      representativeIdentity: "46100:code",
      actionIdentity: "46100:code",
      memberIdentities: ["46100:code", "46177:helper"],
      iconProcess: { pid: 46_100, snapshotStartTime: 1, snapshotBirthToken: "code" },
    };
    const sleep = {
      sampledAtMs: 1,
      available: true,
      blockers: [
        { pid: 46_100, processName: "Code", reason: "Electron", kind: "idle_sleep" as const, durationSeconds: 1_800 },
        { pid: 46_177, processName: "Code Helper", reason: null, kind: "display_sleep" as const, durationSeconds: 60 },
      ],
    };

    expect(summarizeSleepBlockers(sleep, [application])).toEqual([{
      name: "Visual Studio Code",
      systemComponent: false,
      durationSeconds: 1_800,
      kinds: ["idle_sleep", "display_sleep"],
    }]);
    expect(sleepWellbeingLevel(sleep, [application])).toBe("attention");
  });

  it("does not alarm for system-only assertions and reports unavailable platforms honestly", () => {
    const systemSleep = {
      sampledAtMs: 1,
      available: true,
      blockers: [{ pid: 88, processName: "powerd", reason: null, kind: "system_sleep" as const, durationSeconds: 30 }],
    };
    expect(sleepWellbeingLevel(systemSleep, [])).toBe("normal");
    expect(sleepWellbeingLevel({ ...systemSleep, available: false, blockers: [] }, [])).toBe("unavailable");
  });
});
