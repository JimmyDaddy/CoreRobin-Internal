import { describe, expect, it } from "vitest";

import type { ProcessRow } from "./types";
import {
  formatBytes,
  formatRate,
  memoryUsagePercent,
  processDiskRate,
  processIdentity,
  sortAndFilterProcesses,
} from "./utils";

const processFixture = (overrides: Partial<ProcessRow>): ProcessRow => ({
  pid: 1,
  parentPid: null,
  startTime: 100,
  runTimeSeconds: 10,
  name: "process",
  user: "tester",
  status: "Run",
  cpuPercent: 0,
  memoryBytes: 0,
  diskReadBytesPerSecond: 0,
  diskWriteBytesPerSecond: 0,
  protected: false,
  ...overrides,
});

describe("resource formatting", () => {
  it("formats binary byte units", () => {
    expect(formatBytes(1_073_741_824)).toBe("1 GB");
  });

  it("keeps memory percentage in range", () => {
    expect(memoryUsagePercent(75, 100)).toBe(75);
    expect(memoryUsagePercent(150, 100)).toBe(100);
    expect(memoryUsagePercent(10, 0)).toBe(0);
  });

  it("keeps an unsampled process I/O rate in the warming state", () => {
    const process = processFixture({
      diskReadBytesPerSecond: null,
      diskWriteBytesPerSecond: null,
    });

    expect(processDiskRate(process)).toBeNull();
    expect(formatRate(processDiskRate(process))).toBe("预热中");
  });
});

describe("process collection", () => {
  const processes = [
    processFixture({ pid: 30, name: "node", cpuPercent: 120, memoryBytes: 2_000 }),
    processFixture({ pid: 20, name: "Docker", cpuPercent: 20, memoryBytes: 8_000 }),
    processFixture({ pid: 10, name: "Code Helper", cpuPercent: 40, memoryBytes: 4_000 }),
  ];

  it("filters by name, pid, and user", () => {
    expect(sortAndFilterProcesses(processes, "docker", "cpu", "descending")).toHaveLength(1);
    expect(sortAndFilterProcesses(processes, "30", "cpu", "descending")[0].name).toBe("node");
    expect(sortAndFilterProcesses(processes, "tester", "cpu", "descending")).toHaveLength(3);
  });

  it("sorts numeric metrics in the requested direction", () => {
    expect(
      sortAndFilterProcesses(processes, "", "memory", "descending").map(
        (process) => process.name,
      ),
    ).toEqual(["Docker", "Code Helper", "node"]);
  });

  it("uses start time as part of selection identity", () => {
    expect(processIdentity(processes[0])).toBe("30:100");
    expect(processIdentity({ ...processes[0], startTime: 101 })).not.toBe("30:100");
  });
});
