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
): CleanupDeleteLeaseRequest {
  const expectedTargets = items.flatMap(cleanupNodeEvidence);
  return {
    paths: expectedTargets.map((target) => target.path),
    scanSampledAtMs,
    expectedTargets,
    mode,
  };
}

export function applyRefreshedCleanupTargets(
  items: readonly CleanupMapNode[],
  refreshedTargets: readonly CleanupDeleteTargetEvidence[],
): CleanupMapNode[] | null {
  const refreshedByPath = new Map(refreshedTargets.map((target) => [target.path, target]));
  const refreshedItems = items.flatMap((item) => {
    if (!item.path) return [];
    const refreshed = refreshedByPath.get(item.path);
    if (!refreshed) return [];
    return [{
      ...item,
      sizeBytes: refreshed.allocatedSizeBytes,
      logicalSizeBytes: refreshed.logicalSizeBytes,
      allocatedSizeBytes: refreshed.allocatedSizeBytes,
      itemCount: refreshed.itemCount,
      hasChildren: item.kind === "folder" && refreshed.itemCount > 0,
    }];
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
