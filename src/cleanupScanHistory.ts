import type { CleanupNode, CleanupScan } from "./types";

export interface CleanupScanCompactDirectory {
  path: string;
  name: string;
  allocatedSizeBytes: number;
}

export interface CleanupScanCompactSnapshot {
  targetKey: string;
  targetKind: CleanupScan["targetKind"];
  targetPath: string;
  sampledAtMs: number;
  allocatedSizeBytes: number;
  directories: CleanupScanCompactDirectory[];
}

export interface CleanupScanGrowthDirectory extends CleanupScanCompactDirectory {
  previousAllocatedSizeBytes: number;
  growthBytes: number;
}

export interface CleanupScanGrowthComparison {
  previousSampledAtMs: number;
  currentSampledAtMs: number;
  growthBytes: number;
  fastestGrowing: CleanupScanGrowthDirectory[];
}

const MAX_SNAPSHOTS_PER_TARGET = 3;
const MAX_DIRECTORIES = 48;

export function compactCleanupScan(
  scan: CleanupScan,
): CleanupScanCompactSnapshot {
  return {
    targetKey: cleanupScanTargetKey(scan.targetKind, scan.targetPath),
    targetKind: scan.targetKind,
    targetPath: scan.targetPath,
    sampledAtMs: scan.sampledAtMs,
    allocatedSizeBytes: scan.root.allocatedSizeBytes,
    directories: collectDirectories(scan.root)
      .sort((left, right) =>
        right.allocatedSizeBytes - left.allocatedSizeBytes
        || left.path.localeCompare(right.path))
      .slice(0, MAX_DIRECTORIES),
  };
}

export function appendCleanupScanSnapshot(
  snapshots: readonly CleanupScanCompactSnapshot[],
  scan: CleanupScan,
): CleanupScanCompactSnapshot[] {
  const next = compactCleanupScan(scan);
  const sameTarget = snapshots
    .filter((snapshot) =>
      snapshot.targetKey === next.targetKey
      && snapshot.sampledAtMs !== next.sampledAtMs)
    .sort((left, right) => right.sampledAtMs - left.sampledAtMs)
    .slice(0, MAX_SNAPSHOTS_PER_TARGET - 1);
  const otherTargets = snapshots.filter((snapshot) =>
    snapshot.targetKey !== next.targetKey);
  return [...otherTargets, next, ...sameTarget]
    .sort((left, right) => right.sampledAtMs - left.sampledAtMs)
    .slice(0, 30);
}

export function cleanupScanGrowthComparison(
  snapshots: readonly CleanupScanCompactSnapshot[],
  scan: CleanupScan | null,
): CleanupScanGrowthComparison | null {
  if (!scan) return null;
  const key = cleanupScanTargetKey(scan.targetKind, scan.targetPath);
  const previous = snapshots
    .filter((snapshot) =>
      snapshot.targetKey === key && snapshot.sampledAtMs < scan.sampledAtMs)
    .sort((left, right) => right.sampledAtMs - left.sampledAtMs)[0];
  if (!previous) return null;
  const previousByPath = new Map(
    previous.directories.map((directory) => [directory.path, directory]),
  );
  const fastestGrowing = compactCleanupScan(scan).directories
    .map((directory) => {
      const previousDirectory = previousByPath.get(directory.path);
      return {
        ...directory,
        previousAllocatedSizeBytes:
          previousDirectory?.allocatedSizeBytes ?? 0,
        growthBytes:
          directory.allocatedSizeBytes
          - (previousDirectory?.allocatedSizeBytes ?? 0),
      };
    })
    .filter((directory) => directory.growthBytes > 0)
    .sort((left, right) => right.growthBytes - left.growthBytes)
    .slice(0, 5);
  return {
    previousSampledAtMs: previous.sampledAtMs,
    currentSampledAtMs: scan.sampledAtMs,
    growthBytes: scan.root.allocatedSizeBytes - previous.allocatedSizeBytes,
    fastestGrowing,
  };
}

export function parseCleanupScanHistory(
  payload: string | null,
): CleanupScanCompactSnapshot[] {
  if (!payload) return [];
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCompactSnapshot).slice(0, 30);
  } catch {
    return [];
  }
}

export function serializeCleanupScanHistory(
  snapshots: readonly CleanupScanCompactSnapshot[],
): string {
  return JSON.stringify(snapshots);
}

function cleanupScanTargetKey(
  targetKind: CleanupScan["targetKind"],
  targetPath: string,
): string {
  return `${targetKind}:${targetPath}`;
}

function collectDirectories(root: CleanupNode): CleanupScanCompactDirectory[] {
  const directories: CleanupScanCompactDirectory[] = [];
  const visit = (node: CleanupNode, depth: number) => {
    if (node.path && node.kind === "folder" && depth > 0 && depth <= 2) {
      directories.push({
        path: node.path,
        name: node.name,
        allocatedSizeBytes: node.allocatedSizeBytes,
      });
    }
    if (depth < 2) node.children.forEach((child) => visit(child, depth + 1));
  };
  visit(root, 0);
  return directories;
}

function isCompactSnapshot(value: unknown): value is CleanupScanCompactSnapshot {
  if (!isRecord(value)) return false;
  return (
    typeof value.targetKey === "string"
    && (
      value.targetKind === "system_disk"
      || value.targetKind === "volume"
      || value.targetKind === "folder"
    )
    && typeof value.targetPath === "string"
    && finiteNonNegative(value.sampledAtMs)
    && finiteNonNegative(value.allocatedSizeBytes)
    && Array.isArray(value.directories)
    && value.directories.every((directory) =>
      isRecord(directory)
      && typeof directory.path === "string"
      && typeof directory.name === "string"
      && finiteNonNegative(directory.allocatedSizeBytes))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
