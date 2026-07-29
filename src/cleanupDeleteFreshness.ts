import type { CleanupMapNode } from "./cleanupMap";
import type {
  CleanupDeleteLease,
  CleanupDeleteMode,
  CleanupDeleteLeaseRequest,
  CleanupDeleteTargetEvidence,
} from "./types";

export function buildCleanupDeleteLeaseRequest(
  items: readonly CleanupMapNode[],
  scanSampledAtMs: number,
  mode: CleanupDeleteMode,
  scanRoot?: string,
  scanTargetKind: CleanupDeleteLeaseRequest["scanTargetKind"] = "system_disk",
): CleanupDeleteLeaseRequest {
  const expectedTargets = items.flatMap(cleanupNodeEvidence);
  return {
    paths: expectedTargets.map((target) => target.path),
    scanSampledAtMs,
    ...(scanRoot ? { scanRoot } : {}),
    ...(scanTargetKind !== "system_disk" ? { scanTargetKind } : {}),
    expectedTargets,
    mode,
  };
}

export function applyRefreshedCleanupTargets(
  items: readonly CleanupMapNode[],
  refreshedTargets: readonly CleanupDeleteTargetEvidence[],
  missingPaths: readonly string[],
  unavailablePaths: readonly string[],
): CleanupMapNode[] | null {
  const refreshedByPath = new Map(refreshedTargets.map((target) => [target.path, target]));
  const missing = new Set(missingPaths);
  const unavailable = new Set(unavailablePaths);
  const refreshedItems = items.flatMap((item) => {
    if (!item.path) return [];
    const refreshed = refreshedByPath.get(item.path);
    if (refreshed) {
      return [{
        ...item,
        sizeBytes: refreshed.allocatedSizeBytes,
        logicalSizeBytes: refreshed.logicalSizeBytes,
        allocatedSizeBytes: refreshed.allocatedSizeBytes,
        itemCount: refreshed.itemCount,
        hasChildren: item.kind === "folder" && refreshed.itemCount > 0,
      }];
    }
    if (missing.has(item.path)) {
      return [{
        ...item,
        sizeBytes: 0,
        logicalSizeBytes: 0,
        allocatedSizeBytes: 0,
        itemCount: 0,
        hasChildren: false,
        children: [],
      }];
    }
    return unavailable.has(item.path) ? [item] : [];
  });
  return refreshedItems.length === items.length ? refreshedItems : null;
}

export function cleanupLeaseCanExecute(lease: CleanupDeleteLease | null): boolean {
  return lease?.executable === true && lease.changedPaths.length === 0;
}

function cleanupNodeEvidence(node: CleanupMapNode): CleanupDeleteTargetEvidence[] {
  if (!node.path) return [];
  return [{
    path: node.path,
    logicalSizeBytes: node.logicalSizeBytes,
    allocatedSizeBytes: node.allocatedSizeBytes,
    itemCount: node.itemCount,
  }];
}
