import { describe, expect, it } from "vitest";

import {
  appendCleanupScanSnapshot,
  cleanupScanGrowthComparison,
  parseCleanupScanHistory,
  type CleanupScanCompactSnapshot,
} from "./cleanupScanHistory";
import type { CleanupNode, CleanupScan } from "./types";

describe("cleanup scan history", () => {
  it("retains three snapshots per target and explains directory growth", () => {
    let snapshots: CleanupScanCompactSnapshot[] = [];
    for (let index = 0; index < 4; index += 1) {
      snapshots = appendCleanupScanSnapshot(snapshots, scan(index + 1, 100 + index * 20));
    }
    expect(snapshots).toHaveLength(3);
    const comparison = cleanupScanGrowthComparison(snapshots, scan(5, 210));
    expect(comparison?.growthBytes).toBe(50);
    expect(comparison?.fastestGrowing[0]).toMatchObject({
      path: "/Users/example/Downloads",
      growthBytes: 50,
    });
  });

  it("discards malformed persisted entries", () => {
    expect(parseCleanupScanHistory('[{"targetKey":1}]')).toEqual([]);
  });
});

function scan(sampledAtMs: number, size: number): CleanupScan {
  const child: CleanupNode = {
    id: "downloads",
    name: "Downloads",
    path: "/Users/example/Downloads",
    sizeBytes: size,
    logicalSizeBytes: size,
    allocatedSizeBytes: size,
    itemCount: 1,
    safety: "review",
    kind: "folder",
    hasChildren: false,
    children: [],
  };
  return {
    scanId: `fixture-${sampledAtMs}`,
    profile: "complete",
    scopePaths: [],
    indexed: true,
    indexByteSize: 1_024,
    sampledAtMs,
    durationMs: 1,
    root: {
      ...child,
      id: "root",
      name: "example",
      path: "/Users/example",
      children: [child],
    },
    locations: [],
    largestFiles: [],
    installedApplications: [],
    applicationInventoryAvailable: false,
    scannedEntryCount: 1,
    unreadableEntryCount: 0,
    unreadablePaths: [],
    deletionAvailable: true,
    targetKind: "folder",
    targetPath: "/Users/example",
  };
}
