import { describe, expect, it } from "vitest";

import type { ApplicationImpact } from "./diagnosis";
import {
  applicationImpactLevel,
  applicationMemoryPercent,
  applicationPrimaryResource,
  sortApplications,
} from "./applicationImpact";

const MEBIBYTE = 1_024 ** 2;
const GIBIBYTE = 1_024 ** 3;

function application(
  name: string,
  overrides: Partial<ApplicationImpact> = {},
): ApplicationImpact {
  return {
    id: `tester:${name}`,
    name,
    processCount: 1,
    cpuPercent: 0,
    memoryBytes: 0,
    diskBytesPerSecond: 0,
    systemComponent: false,
    representativeIdentity: `${name}:1`,
    actionIdentity: `${name}:1`,
    memberIdentities: [`${name}:1`],
    iconProcess: { pid: 1, snapshotStartTime: 1, snapshotBirthToken: null },
    ...overrides,
  };
}

describe("application impact", () => {
  it("classifies impact without treating modest memory use as critical", () => {
    expect(applicationMemoryPercent(application("Code", { memoryBytes: 2 * GIBIBYTE }), 16 * GIBIBYTE)).toBe(12.5);
    expect(applicationImpactLevel(application("Code", { memoryBytes: 2 * GIBIBYTE }), 16 * GIBIBYTE)).toBe("moderate");
    expect(applicationImpactLevel(application("Build", { cpuPercent: 120 }), 16 * GIBIBYTE)).toBe("critical");
    expect(applicationImpactLevel(application("Copy", { diskBytesPerSecond: 30 * MEBIBYTE }), 16 * GIBIBYTE)).toBe("high");
  });

  it("sorts by the selected resource and uses names as a stable tie breaker", () => {
    const applications = [
      application("Code", { cpuPercent: 20, memoryBytes: 4 * GIBIBYTE }),
      application("Docker", { cpuPercent: 60, memoryBytes: GIBIBYTE }),
      application("Browser", { cpuPercent: 20, memoryBytes: 2 * GIBIBYTE }),
    ];
    expect(sortApplications(applications, "cpu", 16 * GIBIBYTE).map(({ name }) => name)).toEqual([
      "Docker",
      "Browser",
      "Code",
    ]);
    expect(sortApplications(applications, "memory", 16 * GIBIBYTE).map(({ name }) => name)).toEqual([
      "Code",
      "Browser",
      "Docker",
    ]);
  });

  it("explains the resource that dominates an application's impact", () => {
    expect(applicationPrimaryResource(application("Build", { cpuPercent: 80 }), 16 * GIBIBYTE)).toBe("cpu");
    expect(applicationPrimaryResource(application("Photos", { memoryBytes: 4 * GIBIBYTE }), 16 * GIBIBYTE)).toBe("memory");
    expect(applicationPrimaryResource(application("Copy", { diskBytesPerSecond: 40 * MEBIBYTE }), 16 * GIBIBYTE)).toBe("disk");
    expect(applicationPrimaryResource(application("Notes"), 16 * GIBIBYTE)).toBe("balanced");
  });
});
