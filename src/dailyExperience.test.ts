import { describe, expect, it } from "vitest";

import {
  DAILY_INTENTS,
  buildDailyAttentionItems,
  buildDailyStatusItems,
  cleanupReclaimableBytes,
  dailyOverallLevel,
  intentForFinding,
  primaryDailyVolume,
} from "./dailyExperience";
import { analyzeSystemHealth } from "./diagnosis";
import { getMockSnapshot } from "./mockData";

describe("daily experience model", () => {
  it("keeps the home calm when the diagnosis and sensors are normal", () => {
    const snapshot = structuredClone(getMockSnapshot());
    snapshot.processes = snapshot.processes.map((process) => ({
      ...process,
      cpuPercent: 0,
      memoryBytes: 1_024 ** 2,
      diskReadBytesPerSecond: 0,
      diskWriteBytesPerSecond: 0,
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

    expect(dailyOverallLevel(diagnosis, snapshot)).toBe("observing");
    expect(buildDailyAttentionItems(diagnosis, snapshot)).toHaveLength(0);
    expect(buildDailyStatusItems(diagnosis, snapshot).map(({ kind }) => kind)).toEqual([
      "speed",
      "space",
      "temperature",
      "battery",
    ]);
  });

  it("does not turn a single busy app into a system warning by itself", () => {
    const snapshot = structuredClone(getMockSnapshot());
    snapshot.sensors.sleep.blockers = [];
    const diagnosis = analyzeSystemHealth({ snapshot, history: [], connections: null });

    expect(diagnosis.findings).toHaveLength(0);
    expect(buildDailyAttentionItems(diagnosis, snapshot)).toHaveLength(0);
    expect(dailyOverallLevel(diagnosis, snapshot)).toBe("observing");
  });

  it("keeps the complete count while allowing a caller to cap presentation", () => {
    const snapshot = structuredClone(getMockSnapshot());
    snapshot.disk.volumes[0] = {
      ...snapshot.disk.volumes[0]!,
      totalBytes: 100 * 1_024 ** 3,
      availableBytes: 1 * 1_024 ** 3,
    };
    snapshot.sensors.temperature = {
      celsius: 92,
      componentLabel: "CPU",
      criticalCelsius: 100,
    };
    snapshot.sensors.battery = {
      present: true,
      chargePercent: 5,
      healthPercent: 94,
      cycleCount: 173,
      state: "discharging",
      timeRemainingMinutes: 18,
      powerSource: "battery",
    };
    const diagnosis = analyzeSystemHealth({ snapshot, history: [], connections: null });

    const allItems = buildDailyAttentionItems(diagnosis, snapshot);
    const visibleItems = buildDailyAttentionItems(diagnosis, snapshot, 3);
    expect(allItems).toHaveLength(4);
    expect(visibleItems).toHaveLength(3);
    expect(visibleItems.every(({ level }) => level === "urgent")).toBe(true);
    expect(dailyOverallLevel(diagnosis, snapshot)).toBe("urgent");
  });

  it("ignores brief sleep blockers until their duration is trustworthy", () => {
    const snapshot = structuredClone(getMockSnapshot());
    snapshot.sensors.temperature.celsius = 55;
    snapshot.sensors.battery = {
      ...snapshot.sensors.battery,
      present: true,
      chargePercent: 80,
      state: "discharging",
    };
    snapshot.sensors.sleep.blockers = [{
      pid: null,
      processName: "Video Export",
      reason: "Exporting",
      kind: "idle_sleep",
      durationSeconds: 119,
    }];
    const diagnosis = analyzeSystemHealth({ snapshot, history: [], connections: null });

    expect(buildDailyAttentionItems(diagnosis, snapshot)).toHaveLength(0);
    snapshot.sensors.sleep.blockers[0]!.durationSeconds = 120;
    expect(buildDailyAttentionItems(diagnosis, snapshot)).toMatchObject([
      { id: "wellbeing:sleep", kind: "sleep", durationSeconds: 120 },
    ]);
  });

  it("includes plain-language attention items in the overall home status", () => {
    const snapshot = structuredClone(getMockSnapshot());
    snapshot.processes = snapshot.processes.map((process) => ({
      ...process,
      cpuPercent: 0,
      memoryBytes: 1_024 ** 2,
      diskReadBytesPerSecond: 0,
      diskWriteBytesPerSecond: 0,
    }));
    const diagnosis = analyzeSystemHealth({ snapshot, history: [], connections: null });

    expect(buildDailyAttentionItems(diagnosis, snapshot)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "sleep" })]),
    );
    expect(dailyOverallLevel(diagnosis, snapshot)).toBe("attention");
  });

  it("prefers the largest internal volume for the daily space summary", () => {
    const snapshot = structuredClone(getMockSnapshot());
    snapshot.disk.volumes = [
      {
        name: "USB",
        mountPoint: "/Volumes/USB",
        totalBytes: 2_000 * 1_024 ** 3,
        availableBytes: 1_000 * 1_024 ** 3,
        removable: true,
      },
      {
        name: "System",
        mountPoint: "/",
        totalBytes: 500 * 1_024 ** 3,
        availableBytes: 120 * 1_024 ** 3,
        removable: false,
      },
    ];

    expect(primaryDailyVolume(snapshot)?.volume.name).toBe("System");
  });

  it("marks the space status unavailable when no usable volume exists", () => {
    const snapshot = structuredClone(getMockSnapshot());
    snapshot.disk.volumes = [];
    const diagnosis = analyzeSystemHealth({ snapshot, history: [], connections: null });

    expect(
      buildDailyStatusItems(diagnosis, snapshot).find(({ kind }) => kind === "space")
        ?.level,
    ).toBe("unavailable");
  });

  it("counts only available reclaimable cleanup locations", () => {
    expect(cleanupReclaimableBytes({
      sampledAtMs: 0,
      durationMs: 10,
      root: {
        id: "~",
        name: "home",
        path: "~",
        sizeBytes: 28,
        logicalSizeBytes: 28,
        allocatedSizeBytes: 28,
        itemCount: 3,
        safety: "review",
        kind: "folder",
        hasChildren: false,
        children: [],
      },
      locations: [
        { kind: "trash", paths: [], sizeBytes: 8, itemCount: 1, safety: "reclaimable", available: true, nodes: [] },
        { kind: "downloads", paths: [], sizeBytes: 16, itemCount: 1, safety: "review", available: true, nodes: [] },
        { kind: "app_cache", paths: [], sizeBytes: 4, itemCount: 1, safety: "reclaimable", available: false, nodes: [] },
      ],
      largestFiles: [],
      installedApplications: [],
      applicationInventoryAvailable: true,
      scannedEntryCount: 3,
      unreadableEntryCount: 0,
      unreadablePaths: [],
      deletionAvailable: true,
    })).toBe(8);
  });

  it("keeps task-first network and full-check intents in the everyday model", () => {
    expect(DAILY_INTENTS).toEqual(expect.arrayContaining(["network", "checkup"]));
    expect(intentForFinding({
      id: "high_network",
      code: "high_network",
      category: "network",
      severity: "attention",
      actionTarget: "network",
      value: 10,
      threshold: 5,
      durationMs: 12_000,
      secondaryValue: null,
      resourceLabel: null,
      culprit: null,
      recommendation: {
        kind: "open_network",
        safety: "safe",
        target: "network",
        processIdentity: null,
        applicationName: null,
      },
    })).toBe("network");
  });
});
