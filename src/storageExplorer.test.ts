import { describe, expect, it } from "vitest";

import {
  STORAGE_HISTORY_WINDOW_MS,
  sortVolumesByUsage,
  storageHistoryDomain,
  storageHistorySegments,
  storageHistoryWindow,
  topDiskProcesses,
  volumeUsage,
} from "./storageExplorer";
import type { HistoryPoint, ProcessRow, VolumeSnapshot } from "./types";
import { processIdentity } from "./utils";

function volumeFixture(
  name: string,
  totalBytes: number,
  availableBytes: number,
  mountPoint = `/${name}`,
): VolumeSnapshot {
  return {
    name,
    mountPoint,
    totalBytes,
    availableBytes,
    removable: false,
  };
}

function processFixture(
  pid: number,
  read: number | null,
  write: number | null,
): ProcessRow {
  return {
    pid,
    birthToken: `storage:${pid}`,
    parentPid: null,
    startTime: 100,
    runTimeSeconds: 10,
    name: `process-${pid}`,
    user: "tester",
    status: "Run",
    cpuPercent: 1,
    memoryBytes: 1_024,
    diskReadBytesPerSecond: read,
    diskWriteBytesPerSecond: write,
    protected: false,
  };
}

function historyPoint(
  timestamp: number,
  read: number | null,
  write: number | null,
): HistoryPoint {
  return {
    timestamp,
    cpuPercent: 10,
    memoryPercent: 20,
    diskReadBytesPerSecond: read,
    diskWriteBytesPerSecond: write,
    networkReceivedBytesPerSecond: 0,
    networkTransmittedBytesPerSecond: 0,
  };
}

describe("volume usage", () => {
  it("computes used capacity and low-space state", () => {
    expect(volumeUsage(volumeFixture("data", 1_000, 100))).toMatchObject({
      usedBytes: 900,
      usagePercent: 90,
      lowSpace: true,
    });
    expect(volumeUsage(volumeFixture("empty", 0, 200))).toMatchObject({
      usedBytes: 0,
      usagePercent: 0,
      lowSpace: false,
    });
  });

  it("sorts by usage and uses mount point as a deterministic tie-break", () => {
    const high = volumeFixture("high", 1_000, 100);
    const beta = volumeFixture("beta", 1_000, 500, "/b");
    const alpha = volumeFixture("alpha", 1_000, 500, "/a");

    expect(
      sortVolumesByUsage([beta, high, alpha]).map(
        ({ volume }) => volume.mountPoint,
      ),
    ).toEqual(["/high", "/a", "/b"]);
  });
});

describe("top disk processes", () => {
  it("combines one-sided activity, excludes unavailable metrics, and limits rows", () => {
    const inactive = processFixture(1, 0, 0);
    const readOnly = processFixture(2, 500, null);
    const writeOnly = processFixture(3, null, 900);
    const unavailable = processFixture(4, null, null);

    const result = topDiskProcesses(
      [unavailable, inactive, readOnly, writeOnly],
      3,
    );

    expect(result.map(({ process }) => process.pid)).toEqual([3, 2, 1]);
    expect(result.map(({ totalBytesPerSecond }) => totalBytesPerSecond)).toEqual([
      900, 500, 0,
    ]);
  });

  it("uses stable process identity when rates tie", () => {
    const first = processFixture(10, 50, 50);
    const second = processFixture(11, 100, 0);
    const expected = [first, second].map(processIdentity).sort();

    expect(
      topDiskProcesses([second, first]).map(({ process }) =>
        processIdentity(process),
      ),
    ).toEqual(expected);
  });
});

describe("storage history", () => {
  it("sorts samples and keeps the latest five-minute window", () => {
    const latest = STORAGE_HISTORY_WINDOW_MS + 2_000;
    const result = storageHistoryWindow([
      historyPoint(latest, 3, 3),
      historyPoint(1_000, 1, 1),
      historyPoint(2_000, 2, 2),
    ]);

    expect(result.map((point) => point.timestamp)).toEqual([2_000, latest]);
  });

  it("breaks series at null values and long sampling gaps", () => {
    const history = [
      historyPoint(0, 10, 10),
      historyPoint(1_000, 20, null),
      historyPoint(2_000, null, 30),
      historyPoint(8_000, 40, 40),
    ];

    expect(
      storageHistorySegments(history, "read").map((segment) =>
        segment.map((point) => point.value),
      ),
    ).toEqual([[10, 20], [40]]);
    expect(
      storageHistorySegments(history, "write").map((segment) =>
        segment.map((point) => point.value),
      ),
    ).toEqual([[10], [30], [40]]);
  });

  it("uses the collected span while the five-minute chart is warming up", () => {
    expect(storageHistoryDomain([
      historyPoint(10_000, 10, 10),
      historyPoint(14_000, 20, 20),
    ])).toEqual({
      start: 10_000,
      end: 14_000,
      complete: false,
    });
  });

  it("locks to the latest five minutes after enough samples are collected", () => {
    const end = STORAGE_HISTORY_WINDOW_MS + 20_000;
    expect(storageHistoryDomain([
      historyPoint(end - STORAGE_HISTORY_WINDOW_MS, 10, 10),
      historyPoint(end, 20, 20),
    ])).toEqual({
      start: end - STORAGE_HISTORY_WINDOW_MS,
      end,
      complete: true,
    });
  });
});
