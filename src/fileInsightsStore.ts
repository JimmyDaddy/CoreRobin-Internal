import type {
  DuplicateFileGroup,
  FileInsightFile,
  FileInsightsScan,
} from "./types";

export const FILE_INSIGHTS_CACHE_VERSION = 1;
export const FILE_INSIGHTS_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
export const FILE_INSIGHTS_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type FileInsightsSnapshotStatus = "current" | "cached" | "expired";

export interface StoredFileInsightsScan {
  snapshot: FileInsightsScan;
  status: Exclude<FileInsightsSnapshotStatus, "current">;
}

export function parseStoredFileInsightsScan(
  serialized: string | null,
  now = Date.now(),
): StoredFileInsightsScan | null {
  if (!serialized) return null;
  try {
    const value = JSON.parse(serialized) as unknown;
    if (
      !isRecord(value)
      || value.version !== FILE_INSIGHTS_CACHE_VERSION
      || !isFiniteNonNegativeNumber(value.savedAtMs)
      || !isFileInsightsScan(value.snapshot)
    ) {
      return null;
    }
    const ageMs = Math.max(0, now - value.savedAtMs);
    if (ageMs > FILE_INSIGHTS_RETENTION_MS) return null;
    return {
      snapshot: value.snapshot,
      status: ageMs > FILE_INSIGHTS_STALE_AFTER_MS ? "expired" : "cached",
    };
  } catch {
    return null;
  }
}

export function reconcileFileInsightsAfterDeletion(
  snapshot: FileInsightsScan,
  paths: readonly string[],
): FileInsightsScan {
  if (paths.length === 0) return snapshot;
  const removedPaths = new Set(paths);
  const duplicateGroups = snapshot.duplicateGroups.flatMap((group) => {
    const files = group.files.filter((file) => !removedPaths.has(file.path));
    if (files.length < 2) return [];
    return [{
      ...group,
      files,
      reclaimableBytes: group.sizeBytes * (files.length - 1),
    }];
  });
  return {
    ...snapshot,
    duplicateGroups,
    longUnmodifiedFiles: snapshot.longUnmodifiedFiles.filter(
      (file) => !removedPaths.has(file.path),
    ),
  };
}

function isFileInsightsScan(value: unknown): value is FileInsightsScan {
  if (!isRecord(value)) return false;
  return (
    isFiniteNonNegativeNumber(value.sampledAtMs)
    && isFiniteNonNegativeNumber(value.durationMs)
    && isFiniteNonNegativeNumber(value.scannedEntryCount)
    && isFiniteNonNegativeNumber(value.candidateFileCount)
    && isFiniteNonNegativeNumber(value.hashedFileCount)
    && Array.isArray(value.duplicateGroups)
    && value.duplicateGroups.every(isDuplicateFileGroup)
    && Array.isArray(value.longUnmodifiedFiles)
    && value.longUnmodifiedFiles.every(isFileInsightFile)
    && isFiniteNonNegativeNumber(value.unreadableEntryCount)
    && typeof value.truncated === "boolean"
  );
}

function isDuplicateFileGroup(value: unknown): value is DuplicateFileGroup {
  if (!isRecord(value)) return false;
  return (
    typeof value.digest === "string"
    && isFiniteNonNegativeNumber(value.sizeBytes)
    && isFiniteNonNegativeNumber(value.reclaimableBytes)
    && Array.isArray(value.files)
    && value.files.length >= 2
    && value.files.every(isFileInsightFile)
  );
}

function isFileInsightFile(value: unknown): value is FileInsightFile {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === "string"
    && typeof value.path === "string"
    && isFiniteNonNegativeNumber(value.sizeBytes)
    && isFiniteNonNegativeNumber(value.logicalSizeBytes)
    && isFiniteNonNegativeNumber(value.allocatedSizeBytes)
    && (value.modifiedAtMs === null || isFiniteNonNegativeNumber(value.modifiedAtMs))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
