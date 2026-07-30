import { describe, expect, it } from "vitest";

import {
  buildHistoryExport,
  previewHistoryExport,
} from "./historyExport";
import type { HistoryExportSources } from "./historyExport";

const NOW = Date.UTC(2026, 6, 30, 12);

const sources: HistoryExportSources = {
  points: [{
    timestamp: NOW - 1_000,
    cpuPercent: 42,
    memoryPercent: 63,
    diskReadBytesPerSecond: 100,
    diskWriteBytesPerSecond: 20,
    networkReceivedBytesPerSecond: 50,
    networkTransmittedBytesPerSecond: 5,
    topApplicationName: "/private/never-export-this",
  }],
  alerts: [],
  networkQualityPoints: [],
  actions: [{
    id: "action",
    kind: "process_close",
    status: "succeeded",
    verification: "verified",
    startedAtMs: NOW - 500,
    completedAtMs: NOW,
    targetName: "Private App",
    targetCount: 1,
    affectedBytes: null,
    failedCount: null,
  }],
  applicationImpactPoints: [{
    bucketStartMs: NOW - 300_000,
    sampledAtMs: NOW - 250,
    sampleCount: 1,
    applications: [{
      applicationId: "com.private.app",
      name: "Private App",
      sampleCount: 1,
      averageCpuPercent: 10,
      peakCpuPercent: 10,
      averageMemoryBytes: 100,
      peakMemoryBytes: 100,
      averageDiskBytesPerSecond: 5,
      peakDiskBytesPerSecond: 5,
    }],
  }],
};

describe("history export", () => {
  it("excludes names, paths, and commands by default", () => {
    const json = buildHistoryExport(sources, {
      range: 24,
      metrics: ["cpu", "actions", "applications"],
      includeApplicationNames: false,
    }, "json", NOW);

    expect(json).toContain("application-1");
    expect(json).not.toContain("Private App");
    expect(json).not.toContain("com.private.app");
    expect(json).not.toContain("/private/never-export-this");
  });

  it("includes application names only after explicit selection", () => {
    const csv = buildHistoryExport(sources, {
      range: "all",
      metrics: ["actions", "applications"],
      includeApplicationNames: true,
    }, "csv", NOW);

    expect(csv).toContain("Private App");
    expect(csv).toContain("average_cpu_percent");
  });

  it("previews fields and record count before writing", () => {
    const preview = previewHistoryExport(sources, {
      range: 24,
      metrics: ["cpu"],
      includeApplicationNames: false,
    }, NOW);
    expect(preview.recordCount).toBe(1);
    expect(preview.includesApplicationNames).toBe(false);
    expect(preview.excludes).toContain("full file paths");
  });
});
