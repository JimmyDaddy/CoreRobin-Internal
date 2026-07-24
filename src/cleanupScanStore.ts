import type {
  CleanupApplication,
  CleanupFile,
  CleanupLocation,
  CleanupNode,
  CleanupScan,
} from "./types";
import {
  LEGACY_STORAGE_KEYS,
  removeStorageItems,
} from "./storageMigration";

export const CLEANUP_SCAN_STORAGE_KEY = "core-robin.cleanup-scan.v6";
export const CLEANUP_SCAN_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
export const CLEANUP_SCAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type CleanupSnapshotStatus = "current" | "cached" | "expired";

export interface StoredCleanupScan {
  snapshot: CleanupScan;
  status: Exclude<CleanupSnapshotStatus, "current">;
}

export interface CleanupDeletionTargetSnapshot {
  path: string;
  logicalSizeBytes: number;
  allocatedSizeBytes: number;
  itemCount: number;
}

export function reconcileCleanupScanAfterDeletion(
  snapshot: CleanupScan,
  targets: readonly CleanupDeletionTargetSnapshot[],
): CleanupScan {
  const uniqueTargets = deduplicateDeletionTargets(targets);
  if (uniqueTargets.length === 0) return snapshot;

  const targetsByLocation = snapshot.locations.map(() => [] as CleanupDeletionTargetSnapshot[]);
  for (const target of uniqueTargets) {
    const locationIndex = snapshot.locations.findIndex((location) =>
      location.paths.some((path) => isSameOrDescendantPath(target.path, path))
    );
    if (locationIndex >= 0) targetsByLocation[locationIndex].push(target);
  }

  return {
    ...snapshot,
    root: reconcileCleanupNodeAfterDeletion(snapshot.root, uniqueTargets) ?? snapshot.root,
    prefetchedSubtrees: snapshot.prefetchedSubtrees?.flatMap((node) => {
      const reconciled = reconcileCleanupNodeAfterDeletion(node, uniqueTargets);
      return reconciled ? [reconciled] : [];
    }),
    locations: snapshot.locations.map((location, index) => {
      const locationTargets = targetsByLocation[index];
      if (locationTargets.length === 0) return location;
      const allocatedRemoved = locationTargets.reduce((total, target) => total + target.allocatedSizeBytes, 0);
      const itemsRemoved = locationTargets.reduce((total, target) => total + target.itemCount, 0);
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

  const nestedTargets = targets.filter((target) => cleanupNodeContainsPath(node, target.path));
  if (nestedTargets.length === 0) return node;
  const logicalRemoved = nestedTargets.reduce((total, target) => total + target.logicalSizeBytes, 0);
  const allocatedRemoved = nestedTargets.reduce((total, target) => total + target.allocatedSizeBytes, 0);
  const itemsRemoved = nestedTargets.reduce((total, target) => total + target.itemCount, 0);
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
    hasChildren: children.length > 0 || (node.hasChildren && (itemCount > 0 || allocatedSizeBytes > 0)),
    children,
  };
}

function cleanupNodeContainsPath(node: CleanupNode, targetPath: string): boolean {
  if (node.path && isSameOrDescendantPath(targetPath, node.path)) return true;
  return node.children.some((child) => cleanupNodeContainsPath(child, targetPath));
}

export function parseStoredCleanupScan(
  serialized: string | null,
  now = Date.now(),
): StoredCleanupScan | null {
  if (!serialized) return null;
  try {
    const value = JSON.parse(serialized) as unknown;
    const snapshot = normalizeCleanupScan(
      isRecord(value) ? value.snapshot : null,
    );
    if (
      !isRecord(value) ||
      value.version !== 6 ||
      !isFiniteNonNegativeNumber(value.savedAtMs) ||
      !isCleanupScan(snapshot)
    ) {
      return null;
    }
    const ageMs = Math.max(0, now - value.savedAtMs);
    if (ageMs > CLEANUP_SCAN_RETENTION_MS) return null;
    return {
      snapshot,
      status: ageMs > CLEANUP_SCAN_STALE_AFTER_MS ? "expired" : "cached",
    };
  } catch {
    return null;
  }
}

function normalizeCleanupScan(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    prefetchedSubtrees: Array.isArray(value.prefetchedSubtrees)
      ? value.prefetchedSubtrees
      : [],
    installedApplications: Array.isArray(value.installedApplications)
      ? value.installedApplications
      : [],
    applicationInventoryAvailable: typeof value.applicationInventoryAvailable === "boolean"
      ? value.applicationInventoryAvailable
      : false,
  };
}

export function clearStoredCleanupScan(): void {
  try {
    removeStorageItems(
      window.localStorage,
      CLEANUP_SCAN_STORAGE_KEY,
      LEGACY_STORAGE_KEYS.cleanupScan,
    );
  } catch {
    // A storage failure must not prevent a fresh scan from starting.
  }
}

function isCleanupScan(value: unknown): value is CleanupScan {
  if (!isRecord(value)) return false;
  return (
    isFiniteNonNegativeNumber(value.sampledAtMs) &&
    isFiniteNonNegativeNumber(value.durationMs) &&
    isCleanupNode(value.root) &&
    Array.isArray(value.prefetchedSubtrees) &&
    value.prefetchedSubtrees.every(isCleanupNode) &&
    Array.isArray(value.locations) &&
    value.locations.every(isCleanupLocation) &&
    Array.isArray(value.largestFiles) &&
    value.largestFiles.every(isCleanupFile) &&
    Array.isArray(value.installedApplications) &&
    value.installedApplications.every(isCleanupApplication) &&
    typeof value.applicationInventoryAvailable === "boolean" &&
    isFiniteNonNegativeNumber(value.scannedEntryCount) &&
    isFiniteNonNegativeNumber(value.unreadableEntryCount) &&
    Array.isArray(value.unreadablePaths) &&
    value.unreadablePaths.every((path) => typeof path === "string") &&
    typeof value.deletionAvailable === "boolean"
  );
}

function isCleanupApplication(value: unknown): value is CleanupApplication {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    typeof value.path === "string" &&
    isFiniteNonNegativeNumber(value.sizeBytes) &&
    (value.lastUsedAtMs === null || isFiniteNonNegativeNumber(value.lastUsedAtMs)) &&
    (value.modifiedAtMs === null || isFiniteNonNegativeNumber(value.modifiedAtMs))
  );
}

function isCleanupLocation(value: unknown): value is CleanupLocation {
  if (!isRecord(value)) return false;
  return (
    ["downloads", "trash", "app_cache", "developer_cache", "hidden_data"].includes(String(value.kind)) &&
    Array.isArray(value.paths) &&
    value.paths.every((path) => typeof path === "string") &&
    isFiniteNonNegativeNumber(value.sizeBytes) &&
    isFiniteNonNegativeNumber(value.itemCount) &&
    (value.safety === "reclaimable" || value.safety === "review") &&
    typeof value.available === "boolean" &&
    Array.isArray(value.nodes) &&
    value.nodes.every(isCleanupNode)
  );
}

function isCleanupNode(value: unknown): value is CleanupNode {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.path === null || typeof value.path === "string") &&
    isFiniteNonNegativeNumber(value.sizeBytes) &&
    isFiniteNonNegativeNumber(value.logicalSizeBytes) &&
    isFiniteNonNegativeNumber(value.allocatedSizeBytes) &&
    isFiniteNonNegativeNumber(value.itemCount) &&
    typeof value.hasChildren === "boolean" &&
    (value.safety === "reclaimable" || value.safety === "review") &&
    ["folder", "file", "aggregate", "restricted"].includes(String(value.kind)) &&
    Array.isArray(value.children) &&
    value.children.every(isCleanupNode)
  );
}

function isCleanupFile(value: unknown): value is CleanupFile {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === "string" &&
    typeof value.path === "string" &&
    isFiniteNonNegativeNumber(value.sizeBytes) &&
    (value.modifiedAtMs === null || isFiniteNonNegativeNumber(value.modifiedAtMs))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
  return normalizedCandidate === normalizedAncestor || normalizedCandidate.startsWith(`${normalizedAncestor}/`);
}

function normalizeCleanupPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}
