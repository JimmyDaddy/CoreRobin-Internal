import { describe, expect, it } from "vitest";

import {
  aggregateApplications,
  analyzeSystemHealth,
} from "./diagnosis";
import {
  SNAPSHOT_SCHEMA_VERSION,
  type HistoryPoint,
  type ProcessRow,
  type SystemSnapshot,
} from "./types";

const MEBIBYTE = 1_024 ** 2;
const GIBIBYTE = 1_024 ** 3;

function processFixture(
  pid: number,
  overrides: Partial<ProcessRow> = {},
): ProcessRow {
  return {
    pid,
    birthToken: `diagnosis:${pid}`,
    parentPid: null,
    startTime: 100,
    runTimeSeconds: 600,
    name: `process-${pid}`,
    user: "tester",
    status: "Run",
    cpuPercent: 0,
    memoryBytes: 100 * MEBIBYTE,
    diskReadBytesPerSecond: 0,
    diskWriteBytesPerSecond: 0,
    protected: false,
    ...overrides,
  };
}

function snapshotFixture(
  overrides: Partial<SystemSnapshot> = {},
): SystemSnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sequence: 1,
    sampledAtMs: 20_000,
    sampleIntervalMs: 1_000,
    warmingUp: false,
    host: {
      hostname: "test-host",
      osName: "Test OS",
      osVersion: "1",
      kernelVersion: "1",
      architecture: "test",
      cpuName: "test-cpu",
    },
    cpu: {
      usagePercent: 10,
      perCorePercent: [10],
      logicalCoreCount: 1,
    },
    memory: {
      totalBytes: 16 * GIBIBYTE,
      usedBytes: 8 * GIBIBYTE,
      availableBytes: 8 * GIBIBYTE,
      swapTotalBytes: 4 * GIBIBYTE,
      swapUsedBytes: 0,
    },
    disk: {
      readBytesPerSecond: 0,
      writeBytesPerSecond: 0,
      volumes: [{
        name: "Data",
        mountPoint: "/",
        totalBytes: 512 * GIBIBYTE,
        availableBytes: 256 * GIBIBYTE,
        removable: false,
      }],
    },
    network: {
      receivedBytesPerSecond: 0,
      transmittedBytesPerSecond: 0,
      receivedBytesSinceLaunch: 0,
      transmittedBytesSinceLaunch: 0,
      interfaceCount: 0,
      interfaces: [],
    },
    sensors: {
      sampledAtMs: 20_000,
      temperature: { celsius: null, componentLabel: null, criticalCelsius: null },
      battery: {
        present: false,
        chargePercent: null,
        state: "unknown",
        timeRemainingMinutes: null,
        powerSource: "unknown",
      },
      sleep: {
        sampledAtMs: 20_000,
        available: false,
        blockers: [],
      },
    },
    processes: [],
    capabilities: {
      platform: "test",
      processControl: {
        targeting: "unavailable",
        requestClose: { enabled: false, semantic: null, disabledReason: "test" },
        forceKill: { enabled: false, semantic: null, disabledReason: "test" },
        leaseTtlMs: 0,
      },
      requiresConfirmation: true,
    },
    ...overrides,
  };
}

function historyPoint(
  timestamp: number,
  overrides: Partial<HistoryPoint> = {},
): HistoryPoint {
  return {
    timestamp,
    cpuPercent: 10,
    memoryPercent: 50,
    diskReadBytesPerSecond: 0,
    diskWriteBytesPerSecond: 0,
    networkReceivedBytesPerSecond: 0,
    networkTransmittedBytesPerSecond: 0,
    ...overrides,
  };
}

function sustainedHistory(overrides: Partial<HistoryPoint>): HistoryPoint[] {
  return Array.from({ length: 11 }, (_, index) =>
    historyPoint(10_000 + index * 1_000, overrides),
  );
}

describe("application impact aggregation", () => {
  it("groups helper processes under the application users recognize", () => {
    const applications = aggregateApplications([
      processFixture(1, { name: "Code", cpuPercent: 10, memoryBytes: 200 }),
      processFixture(2, { name: "Code Helper", cpuPercent: 20, memoryBytes: 300 }),
      processFixture(3, { name: "launchd", user: "root", protected: true }),
    ]);

    expect(applications.find(({ name }) => name === "Code")).toMatchObject({
      processCount: 2,
      cpuPercent: 30,
      memoryBytes: 500,
      systemComponent: false,
      memberIdentities: ["1:diagnosis:1", "2:diagnosis:2"],
      actionIdentity: "1:diagnosis:1",
      iconProcess: {
        pid: 2,
        snapshotStartTime: 100,
        snapshotBirthToken: "diagnosis:2",
      },
    });
    expect(applications.find(({ name }) => name === "launchd")?.systemComponent).toBe(true);
  });

  it("attributes generic runtimes to their visible parent application", () => {
    const applications = aggregateApplications([
      processFixture(10, { name: "Terminal", cpuPercent: 2 }),
      processFixture(11, {
        name: "node",
        parentPid: 10,
        cpuPercent: 140,
      }),
    ]);

    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({
      name: "Terminal",
      processCount: 2,
      cpuPercent: 142,
      representativeIdentity: "11:diagnosis:11",
      actionIdentity: "10:diagnosis:10",
      iconProcess: {
        pid: 11,
        snapshotStartTime: 100,
        snapshotBirthToken: "diagnosis:11",
      },
    });
  });
});

describe("smart diagnosis", () => {
  it("observes until a sustained baseline exists, then reports healthy", () => {
    const snapshot = snapshotFixture();
    expect(analyzeSystemHealth({ snapshot, history: [], connections: null }).status).toBe("observing");
    expect(
      analyzeSystemHealth({
        snapshot,
        history: sustainedHistory({}),
        connections: null,
      }).status,
    ).toBe("healthy");
  });

  it("finds sustained CPU pressure and attributes the busiest application", () => {
    const snapshot = snapshotFixture({
      cpu: { usagePercent: 82, perCorePercent: [82], logicalCoreCount: 4 },
      processes: [
        processFixture(1, { name: "Code", cpuPercent: 20 }),
        processFixture(2, { name: "Code Helper", cpuPercent: 55 }),
      ],
      capabilities: {
        platform: "test",
        processControl: {
          targeting: "stable_handle",
          requestClose: { enabled: true, semantic: "sigterm", disabledReason: null },
          forceKill: { enabled: true, semantic: "sigkill", disabledReason: null },
          leaseTtlMs: 60_000,
        },
        requiresConfirmation: true,
      },
    });
    const result = analyzeSystemHealth({
      snapshot,
      history: sustainedHistory({ cpuPercent: 82 }),
      connections: null,
    });

    expect(result.status).toBe("attention");
    expect(result.findings[0]).toMatchObject({
      code: "sustained_cpu",
      durationMs: 10_000,
      culprit: { name: "Code", processCount: 2, cpuPercent: 75 },
      recommendation: {
        kind: "request_close",
        safety: "confirmation",
        processIdentity: "1:diagnosis:1",
      },
    });
  });

  it("does not mistake ordinary memory use for pressure", () => {
    const snapshot = snapshotFixture({
      memory: {
        totalBytes: 10 * GIBIBYTE,
        usedBytes: 9 * GIBIBYTE,
        availableBytes: 1 * GIBIBYTE,
        swapTotalBytes: 4 * GIBIBYTE,
        swapUsedBytes: 0,
      },
    });
    const result = analyzeSystemHealth({
      snapshot,
      history: sustainedHistory({ memoryPercent: 90 }),
      connections: null,
    });

    expect(result.findings.some(({ code }) => code === "memory_pressure")).toBe(false);
  });

  it("reports urgent memory pressure only with scarce memory and swap use", () => {
    const snapshot = snapshotFixture({
      memory: {
        totalBytes: 16 * GIBIBYTE,
        usedBytes: 15.5 * GIBIBYTE,
        availableBytes: 0.4 * GIBIBYTE,
        swapTotalBytes: 4 * GIBIBYTE,
        swapUsedBytes: 2 * GIBIBYTE,
      },
      processes: [processFixture(1, { name: "Photos", memoryBytes: 4 * GIBIBYTE })],
    });
    const result = analyzeSystemHealth({ snapshot, history: [], connections: null });

    expect(result.findings[0]).toMatchObject({
      code: "memory_pressure",
      severity: "urgent",
      culprit: { name: "Photos" },
    });
  });

  it("reports low storage with the affected volume and remaining bytes", () => {
    const snapshot = snapshotFixture({
      disk: {
        readBytesPerSecond: 0,
        writeBytesPerSecond: 0,
        volumes: [{
          name: "System",
          mountPoint: "/",
          totalBytes: 100 * GIBIBYTE,
          availableBytes: 8 * GIBIBYTE,
          removable: false,
        }],
      },
    });
    const result = analyzeSystemHealth({ snapshot, history: [], connections: null });

    expect(result.findings[0]).toMatchObject({
      code: "low_storage",
      severity: "attention",
      resourceLabel: "System",
      secondaryValue: 8 * GIBIBYTE,
      recommendation: {
        kind: "open_cleanup",
        safety: "safe",
        target: "cleanup",
      },
    });
  });

  it("attributes sustained disk activity to the busiest application", () => {
    const snapshot = snapshotFixture({
      processes: [processFixture(1, {
        name: "Docker Desktop",
        diskReadBytesPerSecond: 20 * MEBIBYTE,
        diskWriteBytesPerSecond: 30 * MEBIBYTE,
      })],
    });
    const result = analyzeSystemHealth({
      snapshot,
      history: sustainedHistory({
        diskReadBytesPerSecond: 30 * MEBIBYTE,
        diskWriteBytesPerSecond: 30 * MEBIBYTE,
      }),
      connections: null,
    });

    expect(result.findings[0]).toMatchObject({
      code: "busy_disk",
      culprit: { name: "Docker Desktop" },
    });
  });

  it("describes sustained network traffic without claiming an address is malicious", () => {
    const snapshot = snapshotFixture();
    const result = analyzeSystemHealth({
      snapshot,
      history: sustainedHistory({
        networkReceivedBytesPerSecond: 20 * MEBIBYTE,
        networkTransmittedBytesPerSecond: 10 * MEBIBYTE,
      }),
      connections: null,
    });

    expect(result.findings[0]).toMatchObject({
      code: "high_network",
      severity: "attention",
      actionTarget: "network",
      recommendation: {
        kind: "open_network",
        safety: "safe",
        target: "network",
      },
    });
  });

  it("never offers a quit action for a system component", () => {
    const snapshot = snapshotFixture({
      cpu: { usagePercent: 96, perCorePercent: [96], logicalCoreCount: 4 },
      processes: [processFixture(1, {
        name: "WindowServer",
        user: "_windowserver",
        cpuPercent: 96,
      })],
      capabilities: {
        platform: "test",
        processControl: {
          targeting: "stable_handle",
          requestClose: { enabled: true, semantic: "sigterm", disabledReason: null },
          forceKill: { enabled: true, semantic: "sigkill", disabledReason: null },
          leaseTtlMs: 60_000,
        },
        requiresConfirmation: true,
      },
    });
    const result = analyzeSystemHealth({
      snapshot,
      history: sustainedHistory({ cpuPercent: 96 }),
      connections: null,
    });

    expect(result.findings[0]?.recommendation).toMatchObject({
      kind: "inspect_process",
      safety: "protected",
      processIdentity: "1:diagnosis:1",
    });
  });
});
