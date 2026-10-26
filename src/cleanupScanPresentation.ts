import type { CleanupScan, CleanupScanTarget } from "./types";

/** An empty, read-only surface until the worker publishes its first checkpoint. */
export function preparingCleanupScan(target: CleanupScanTarget, name: string): CleanupScan {
  const path = target.targetPath ?? "/";
  return {
    scanId: `preparing:${target.targetKind}:${path}`,
    partial: true,
    indexed: false,
    indexByteSize: 0,
    profile: target.profile ?? "complete",
    scopePaths: [path],
    targetKind: target.targetKind,
    targetPath: path,
    sampledAtMs: 0,
    durationMs: 0,
    root: {
      id: `preparing:${path}`, name, path, kind: "folder", safety: "review",
      sizeBytes: 0, logicalSizeBytes: 0, allocatedSizeBytes: 0, itemCount: 0,
      hasChildren: false, children: [], deletionProtected: true, protectionReason: "aggregate",
    },
    locations: [], largestFiles: [], installedApplications: [],
    applicationInventoryAvailable: false, scannedEntryCount: 0,
    unreadableEntryCount: 0, unreadablePaths: [], deletionAvailable: false,
  };
}
