import type { CleanupScanTarget } from "./types";

export const CLEANUP_RECENT_TARGETS_STORAGE_KEY =
  "core-robin.cleanup.recent-targets.v1";
const MAX_RECENT_TARGETS = 5;

export function loadRecentCleanupTargets(
  storage: Storage = window.localStorage,
): CleanupScanTarget[] {
  try {
    const value = JSON.parse(
      storage.getItem(CLEANUP_RECENT_TARGETS_STORAGE_KEY) ?? "[]",
    ) as unknown;
    return Array.isArray(value)
      ? value.filter(isCleanupScanTarget).slice(0, MAX_RECENT_TARGETS)
      : [];
  } catch {
    return [];
  }
}

export function saveRecentCleanupTarget(
  target: CleanupScanTarget,
  storage: Storage = window.localStorage,
): CleanupScanTarget[] {
  if (target.targetKind === "system_disk" || !target.targetPath) {
    return loadRecentCleanupTargets(storage);
  }
  const next = [
    target,
    ...loadRecentCleanupTargets(storage).filter(
      (current) => current.targetPath !== target.targetPath,
    ),
  ].slice(0, MAX_RECENT_TARGETS);
  try {
    storage.setItem(CLEANUP_RECENT_TARGETS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The selected target is still usable for the current scan.
  }
  return next;
}

function isCleanupScanTarget(value: unknown): value is CleanupScanTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Partial<CleanupScanTarget>;
  return (target.targetKind === "volume" || target.targetKind === "folder")
    && typeof target.targetPath === "string"
    && target.targetPath.length > 0;
}
