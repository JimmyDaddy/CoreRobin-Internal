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

export const CLEANUP_SCAN_STORAGE_KEY = "status-orbit.cleanup-scan.v3";
export const CLEANUP_SCAN_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
export const CLEANUP_SCAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type CleanupSnapshotStatus = "current" | "cached" | "expired";

export interface StoredCleanupScan {
  snapshot: CleanupScan;
  status: Exclude<CleanupSnapshotStatus, "current">;
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
      value.version !== 3 ||
      !isFiniteNonNegativeNumber(value.savedAtMs) ||
      !isCleanupScan(snapshot)
    ) {
      return null;
    }
    const ageMs = Math.max(0, now - value.savedAtMs);
    if (ageMs > CLEANUP_SCAN_RETENTION_MS) return null;
    return {
      // Cleanup availability belongs to the running StatusOrbit build, not to the
      // historical scan. Older retained maps become actionable after the
      // backend adds the guarded permanent-deletion workflow.
      snapshot: { ...snapshot, deletionAvailable: true },
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
