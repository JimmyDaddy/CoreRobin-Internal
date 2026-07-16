import { describe, expect, it } from "vitest";

import type { ProcessRow } from "./types";
import {
  assertSupportedSnapshotSchema,
  detailMatchesProcess,
  formatBytes,
  formatRate,
  memoryUsagePercent,
  processDiskRate,
  processIdentity,
  processKeysEqual,
  resourceUsageLevel,
  sortAndFilterProcesses,
} from "./utils";

const processFixture = (overrides: Partial<ProcessRow>): ProcessRow => ({
  pid: 1,
  birthToken: null,
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
  it("accepts only the current snapshot schema", () => {
    expect(() => assertSupportedSnapshotSchema({ schemaVersion: 7 })).not.toThrow();
    expect(() => assertSupportedSnapshotSchema({ schemaVersion: 5 })).toThrow(
      "不支持的数据版本：5",
    );
  });

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

  it("maps percentages to stable semantic usage levels", () => {
    expect(resourceUsageLevel(null)).toBe("unavailable");
    expect(resourceUsageLevel(20)).toBe("low");
    expect(resourceUsageLevel(50)).toBe("moderate");
    expect(resourceUsageLevel(75)).toBe("high");
    expect(resourceUsageLevel(95)).toBe("critical");
    expect(resourceUsageLevel(101, [10, 50, 100])).toBe("critical");
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

  it("prefers the native birth token for selection identity", () => {
    const process = { ...processes[0], birthToken: "macos:100:42" };
    expect(processIdentity(process)).toBe("30:macos:100:42");
    expect(processIdentity({ ...process, startTime: 101 })).toBe(
      "30:macos:100:42",
    );
  });

  it("falls back to start time when native identity is unavailable", () => {
    expect(processIdentity(processes[0])).toBe("30:fallback:100");
    expect(processIdentity({ ...processes[0], startTime: 101 })).not.toBe(
      "30:fallback:100",
    );
  });

  it("does not bind stale detail or action keys to a replacement process", () => {
    const process = processFixture({
      pid: 30,
      birthToken: "macos:100:42",
      startTime: 100,
    });
    const matchingKey = { pid: 30, birthToken: "macos:100:42" };
    const replacementKey = { pid: 30, birthToken: "macos:100:99" };

    expect(
      detailMatchesProcess(
        { pid: 30, startTime: 100, key: matchingKey },
        process,
      ),
    ).toBe(true);
    expect(
      detailMatchesProcess(
        { pid: 30, startTime: 100, key: replacementKey },
        process,
      ),
    ).toBe(false);
    expect(processKeysEqual(matchingKey, replacementKey)).toBe(false);
  });
});
