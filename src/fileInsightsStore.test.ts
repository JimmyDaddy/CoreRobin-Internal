import { describe, expect, it } from "vitest";

import {
  FILE_INSIGHTS_RETENTION_MS,
  FILE_INSIGHTS_STALE_AFTER_MS,
  parseStoredFileInsightsScan,
  reconcileFileInsightsAfterDeletion,
} from "./fileInsightsStore";
import type { FileInsightsScan } from "./types";

describe("file insights result cache", () => {
  it("restores recent results as saved data and marks older results stale", () => {
    const now = 2_000_000_000_000;
    expect(parseStoredFileInsightsScan(payload(now - 1_000), now)?.status).toBe("cached");
    expect(parseStoredFileInsightsScan(
      payload(now - FILE_INSIGHTS_STALE_AFTER_MS - 1),
      now,
    )?.status).toBe("expired");
  });

  it("drops results after the retention window or when the payload is malformed", () => {
    const now = 2_000_000_000_000;
    expect(parseStoredFileInsightsScan(
      payload(now - FILE_INSIGHTS_RETENTION_MS - 1),
      now,
    )).toBeNull();
    expect(parseStoredFileInsightsScan('{"version":1,"savedAtMs":2,"snapshot":{}}', now)).toBeNull();
  });

  it("removes processed paths before the corrected result is saved again", () => {
    const updated = reconcileFileInsightsAfterDeletion(SCAN, ["/two"]);
    expect(updated.duplicateGroups).toHaveLength(0);
    expect(updated.longUnmodifiedFiles.map((file) => file.path)).toEqual(["/old"]);
  });
});

function payload(savedAtMs: number): string {
  return JSON.stringify({ version: 1, savedAtMs, snapshot: SCAN });
}

const FILE = {
  name: "one.bin",
  path: "/one",
  sizeBytes: 10,
  logicalSizeBytes: 10,
  allocatedSizeBytes: 12,
  modifiedAtMs: 1,
};

const SCAN: FileInsightsScan = {
  sampledAtMs: 1,
  durationMs: 2,
  scannedEntryCount: 3,
  candidateFileCount: 2,
  hashedFileCount: 2,
  duplicateGroups: [{
    digest: "digest",
    sizeBytes: 10,
    reclaimableBytes: 10,
    files: [FILE, { ...FILE, name: "two.bin", path: "/two" }],
  }],
  longUnmodifiedFiles: [{ ...FILE, name: "old.bin", path: "/old" }],
  unreadableEntryCount: 0,
  truncated: false,
};
