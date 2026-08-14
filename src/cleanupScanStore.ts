import type { CleanupNode, CleanupScan } from "./types";

export type CleanupSnapshotStatus = "current" | "cached" | "expired" | "updating";

export interface CleanupDeletionTargetSnapshot {
  id?: string;
  path: string;
  logicalSizeBytes: number;
  allocatedSizeBytes: number;
  itemCount: number;
}

/**
 * Reconciles path-only items added by another workspace. Indexed cleanup-map
 * items are reconciled transactionally by the native SQLite index instead.
 */
export function reconcileCleanupScanAfterDeletion(
  snapshot: CleanupScan,
  targets: readonly CleanupDeletionTargetSnapshot[],
): CleanupScan {
  const uniqueTargets = deduplicateDeletionTargets(targets);
  if (uniqueTargets.length === 0) return snapshot;

  const targetsByLocation = snapshot.locations.map(
    () => [] as CleanupDeletionTargetSnapshot[],
  );
  for (const target of uniqueTargets) {
    const locationIndex = snapshot.locations.findIndex((location) =>
      location.paths.some((path) => isSameOrDescendantPath(target.path, path))
    );
    if (locationIndex >= 0) targetsByLocation[locationIndex].push(target);
  }

  return {
    ...snapshot,
    root: reconcileCleanupNodeAfterDeletion(snapshot.root, uniqueTargets) ?? snapshot.root,
    locations: snapshot.locations.map((location, index) => {
      const locationTargets = targetsByLocation[index];
      if (locationTargets.length === 0) return location;
      const allocatedRemoved = locationTargets.reduce(
        (total, target) => total + target.allocatedSizeBytes,
        0,
      );
      const itemsRemoved = locationTargets.reduce(
        (total, target) => total + target.itemCount,
        0,
      );
      return {
        ...location,
        sizeBytes: Math.max(0, location.sizeBytes - allocatedRemoved),
        itemCount: Math.max(0, location.itemCount - itemsRemoved),
        nodes: location.nodes.flatMap((node) => {
          const reconciled = reconcileCleanupNodeAfterDeletion(node, locationTargets);
          return reconciled ? [reconciled] : [];
        }),
      };
    }),
    largestFiles: snapshot.largestFiles.filter((file) =>
      !uniqueTargets.some((target) => isSameOrDescendantPath(file.path, target.path))
    ),
  };
}

export function reconcileCleanupNodeAfterDeletion(
  node: CleanupNode,
  targets: readonly CleanupDeletionTargetSnapshot[],
): CleanupNode | null {
  if (node.path && targets.some((target) => isSameOrDescendantPath(node.path!, target.path))) {
    return null;
  }
  if (!node.path) return node;

  const nestedTargets = targets.filter((target) =>
    cleanupNodeContainsPath(node, target.path)
  );
  if (nestedTargets.length === 0) return node;

  const logicalRemoved = nestedTargets.reduce(
    (total, target) => total + target.logicalSizeBytes,
    0,
  );
  const allocatedRemoved = nestedTargets.reduce(
    (total, target) => total + target.allocatedSizeBytes,
    0,
  );
  const itemsRemoved = nestedTargets.reduce(
    (total, target) => total + target.itemCount,
    0,
  );
  const children = node.children.flatMap((child) => {
    const reconciled = reconcileCleanupNodeAfterDeletion(child, nestedTargets);
    return reconciled ? [reconciled] : [];
  });
  const allocatedSizeBytes = Math.max(0, node.allocatedSizeBytes - allocatedRemoved);
  const itemCount = Math.max(0, node.itemCount - itemsRemoved);
  return {
    ...node,
    sizeBytes: allocatedSizeBytes,
    logicalSizeBytes: Math.max(0, node.logicalSizeBytes - logicalRemoved),
    allocatedSizeBytes,
    itemCount,
    hasChildren:
      children.length > 0 ||
      (node.hasChildren && (itemCount > 0 || allocatedSizeBytes > 0)),
    children,
  };
}

function cleanupNodeContainsPath(node: CleanupNode, targetPath: string): boolean {
  if (node.path && isSameOrDescendantPath(targetPath, node.path)) return true;
  return node.children.some((child) => cleanupNodeContainsPath(child, targetPath));
}

function deduplicateDeletionTargets(
  targets: readonly CleanupDeletionTargetSnapshot[],
): CleanupDeletionTargetSnapshot[] {
  const byPath = new Map<string, CleanupDeletionTargetSnapshot>();
  for (const target of targets) byPath.set(normalizeCleanupPath(target.path), target);
  return [...byPath.values()];
}

function isSameOrDescendantPath(candidate: string, ancestor: string): boolean {
  const normalizedCandidate = normalizeCleanupPath(candidate);
  const normalizedAncestor = normalizeCleanupPath(ancestor);
  return normalizedCandidate === normalizedAncestor ||
    normalizedCandidate.startsWith(`${normalizedAncestor}/`);
}

function normalizeCleanupPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}
