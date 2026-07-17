import type { HistoryPoint } from "./types";
import {
  LEGACY_STORAGE_KEYS,
  readMigratedStorageItem,
  removeStorageItems,
} from "./storageMigration";
import { isProductDataResetInProgress } from "./productSupport";

export const PERSISTENT_HISTORY_STORAGE_KEY = "core-robin.resource-history.v1";
export const PERSISTENT_HISTORY_BUCKET_MS = 5 * 60 * 1_000;
export const HISTORY_RETENTION_OPTIONS = [1, 7, 30] as const;
export const MAX_PERSISTENT_HISTORY_POINTS =
  30 * 24 * (60 * 60 * 1_000) / PERSISTENT_HISTORY_BUCKET_MS;

export type HistoryRetentionDays = (typeof HISTORY_RETENTION_OPTIONS)[number];

interface PersistentHistoryPayload {
  version: 1;
  points: HistoryPoint[];
}

export function parsePersistentHistory(serialized: string | null): HistoryPoint[] {
  if (!serialized) return [];
  try {
    const value = JSON.parse(serialized) as unknown;
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.points)) {
      return [];
    }
    return value.points
      .filter(isHistoryPoint)
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(-MAX_PERSISTENT_HISTORY_POINTS);
  } catch {
    return [];
  }
}

export function loadPersistentHistory(): HistoryPoint[] {
  try {
    return parsePersistentHistory(
      readMigratedStorageItem(
        window.localStorage,
        PERSISTENT_HISTORY_STORAGE_KEY,
        LEGACY_STORAGE_KEYS.resourceHistory,
      ),
    );
  } catch {
    return [];
  }
}

export function savePersistentHistory(points: readonly HistoryPoint[]): void {
  if (isProductDataResetInProgress()) return;
  try {
    const payload: PersistentHistoryPayload = {
      version: 1,
      points: points.filter(isHistoryPoint).slice(-MAX_PERSISTENT_HISTORY_POINTS),
    };
    window.localStorage.setItem(
      PERSISTENT_HISTORY_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch {
    // History remains available for the current session when storage is blocked
    // or the WebView quota has been exhausted.
  }
}

export function clearPersistentHistoryStorage(): void {
  try {
    removeStorageItems(
      window.localStorage,
      PERSISTENT_HISTORY_STORAGE_KEY,
      LEGACY_STORAGE_KEYS.resourceHistory,
    );
  } catch {
    // Clearing the in-memory copy is still useful when storage is unavailable.
  }
}

export function mergePersistentHistory(
  stored: readonly HistoryPoint[],
  incoming: readonly HistoryPoint[],
  now: number,
  retentionDays: HistoryRetentionDays,
): HistoryPoint[] {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1_000;
  const latestByBucket = new Map<number, HistoryPoint>();

  for (const point of [...stored, ...incoming]) {
    if (!isHistoryPoint(point) || point.timestamp < cutoff || point.timestamp > now) {
      continue;
    }
    const bucket = Math.floor(point.timestamp / PERSISTENT_HISTORY_BUCKET_MS);
    const existing = latestByBucket.get(bucket);
    if (!existing || point.timestamp >= existing.timestamp) {
      latestByBucket.set(bucket, point);
    }
  }

  return [...latestByBucket.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-MAX_PERSISTENT_HISTORY_POINTS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHistoryPoint(value: unknown): value is HistoryPoint {
  if (!isRecord(value)) return false;
  return (
    isFiniteNumber(value.timestamp) &&
    value.timestamp > 0 &&
    isPercentage(value.cpuPercent) &&
    isPercentage(value.memoryPercent) &&
    isNullableNonNegativeNumber(value.diskReadBytesPerSecond) &&
    isNullableNonNegativeNumber(value.diskWriteBytesPerSecond) &&
    isNullableNonNegativeNumber(value.networkReceivedBytesPerSecond) &&
    isNullableNonNegativeNumber(value.networkTransmittedBytesPerSecond)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isPercentage(value: unknown): value is number {
  return isNonNegativeNumber(value) && value <= 100;
}

function isNullableNonNegativeNumber(value: unknown): value is number | null {
  return value === null || isNonNegativeNumber(value);
}
