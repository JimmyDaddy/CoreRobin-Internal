import { describe, expect, it } from "vitest";

import type { ApplicationImpact } from "./diagnosis";
import { alertCulpritName } from "./alertAttribution";

function application(
  name: string,
  cpuPercent: number,
  memoryBytes: number,
): ApplicationImpact {
  return {
    id: name,
    name,
    processCount: 1,
    cpuPercent,
    memoryBytes,
    diskBytesPerSecond: 0,
    systemComponent: false,
    representativeIdentity: `${name}:1`,
    actionIdentity: `${name}:1`,
    memberIdentities: [`${name}:1`],
    iconProcess: {
      pid: 1,
      snapshotStartTime: 1,
      snapshotBirthToken: name,
    },
  };
}

describe("resource alert attribution", () => {
  it("records a recognizable app only when its CPU impact is meaningful", () => {
    const applications = [
      application("Docker Desktop", 84, 2_000),
      application("Finder", 12, 1_000),
    ];
    expect(alertCulpritName("cpu", applications, 16_000)).toBe("Docker Desktop");
    expect(alertCulpritName("cpu", [application("Finder", 12, 1_000)], 16_000)).toBeNull();
  });

  it("requires one app to explain a meaningful share of memory pressure", () => {
    expect(
      alertCulpritName("memory", [application("Docker Desktop", 2, 2_000)], 16_000),
    ).toBe("Docker Desktop");
    expect(
      alertCulpritName("memory", [application("Finder", 2, 800)], 16_000),
    ).toBeNull();
    expect(alertCulpritName("volume", [], 16_000)).toBeNull();
  });
});
