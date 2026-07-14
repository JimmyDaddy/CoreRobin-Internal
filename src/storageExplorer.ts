import type { HistoryPoint, ProcessRow, VolumeSnapshot } from "./types";
import { processDiskRate, processIdentity } from "./utils";

export const STORAGE_HISTORY_WINDOW_MS = 5 * 60 * 1_000;
export const STORAGE_SAMPLE_GAP_MS = 5_000;

export interface VolumeUsage {
  volume: VolumeSnapshot;
  usedBytes: number;
  usagePercent: number;
  lowSpace: boolean;
}

export interface DiskProcessActivity {
  process: ProcessRow;
  totalBytesPerSecond: number;
}

export interface StorageSeriesPoint {
  timestamp: number;
  value: number;
}

export type StorageMetric = "read" | "write";

export function volumeUsage(volume: VolumeSnapshot): VolumeUsage {
  const totalBytes = Math.max(0, volume.totalBytes);
  const availableBytes = Math.min(
    totalBytes,
    Math.max(0, volume.availableBytes),
  );
  const usedBytes = Math.max(0, totalBytes - availableBytes);
  const usagePercent =
    totalBytes === 0 ? 0 : Math.min(100, (usedBytes / totalBytes) * 100);
  return {
    volume,
    usedBytes,
    usagePercent,
    lowSpace: usagePercent >= 85,
  };
}

export function sortVolumesByUsage(
  volumes: readonly VolumeSnapshot[],
): VolumeUsage[] {
  return volumes
    .map(volumeUsage)
    .sort(
      (left, right) =>
        right.usagePercent - left.usagePercent ||
        left.volume.mountPoint.localeCompare(right.volume.mountPoint),
    );
}

export function topDiskProcesses(
  processes: readonly ProcessRow[],
  limit = 8,
): DiskProcessActivity[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return processes
    .flatMap((process) => {
      const totalBytesPerSecond = processDiskRate(process);
      return totalBytesPerSecond === null
        ? []
        : [{ process, totalBytesPerSecond }];
    })
    .sort(
      (left, right) =>
        right.totalBytesPerSecond - left.totalBytesPerSecond ||
        processIdentity(left.process).localeCompare(processIdentity(right.process)),
    )
    .slice(0, safeLimit);
}

export function storageHistoryWindow(
  history: readonly HistoryPoint[],
): HistoryPoint[] {
  if (history.length === 0) return [];
  const ordered = [...history].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
  const latestTimestamp = ordered[ordered.length - 1]?.timestamp ?? 0;
  const cutoff = latestTimestamp - STORAGE_HISTORY_WINDOW_MS;
  return ordered.filter((point) => point.timestamp >= cutoff);
}

export function storageHistorySegments(
  history: readonly HistoryPoint[],
  metric: StorageMetric,
): StorageSeriesPoint[][] {
  const points = storageHistoryWindow(history);
  const segments: StorageSeriesPoint[][] = [];
  let current: StorageSeriesPoint[] = [];
  for (const [index, point] of points.entries()) {
    const previous = points[index - 1];
    const followsGap =
      previous !== undefined &&
      point.timestamp - previous.timestamp > STORAGE_SAMPLE_GAP_MS;
    if (followsGap && current.length > 0) {
      segments.push(current);
      current = [];
    }

    const value =
      metric === "read"
        ? point.diskReadBytesPerSecond
        : point.diskWriteBytesPerSecond;
    if (value === null || !Number.isFinite(value)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push({ timestamp: point.timestamp, value: Math.max(0, value) });
  }
  if (current.length > 0) segments.push(current);
  return segments;
}
