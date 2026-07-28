import type { ApplicationImpact } from "./diagnosis";

export const APPLICATION_IMPACT_HISTORY_STORAGE_KEY =
  "core-robin.application-impact-history.v1";
export const APPLICATION_IMPACT_HISTORY_BUCKET_MS = 5 * 60 * 1_000;
export const APPLICATION_IMPACT_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const APPLICATION_IMPACT_HISTORY_MAX_APPS = 12;

export type ApplicationImpactHistoryRangeHours = 1 | 24 | 168;

export interface ApplicationImpactHistoryEntry {
  applicationId: string;
  name: string;
  sampleCount: number;
  averageCpuPercent: number;
  peakCpuPercent: number;
  averageMemoryBytes: number;
  peakMemoryBytes: number;
  averageDiskBytesPerSecond: number;
  peakDiskBytesPerSecond: number;
}

export interface ApplicationImpactHistoryPoint {
  bucketStartMs: number;
  sampledAtMs: number;
  sampleCount: number;
  applications: ApplicationImpactHistoryEntry[];
}

interface StoredApplicationImpactHistory {
  version: 1;
  points: ApplicationImpactHistoryPoint[];
}

export function loadApplicationImpactHistory(
  storage: Storage = window.localStorage,
): ApplicationImpactHistoryPoint[] {
  try {
    const value = JSON.parse(
      storage.getItem(APPLICATION_IMPACT_HISTORY_STORAGE_KEY) ?? "null",
    ) as unknown;
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.points)) {
      return [];
    }
    return value.points
      .filter(isApplicationImpactHistoryPoint)
      .sort((left, right) => left.bucketStartMs - right.bucketStartMs);
  } catch {
    return [];
  }
}

export function saveApplicationImpactHistory(
  points: readonly ApplicationImpactHistoryPoint[],
  storage: Storage = window.localStorage,
): void {
  try {
    const payload: StoredApplicationImpactHistory = {
      version: 1,
      points: [...points],
    };
    storage.setItem(
      APPLICATION_IMPACT_HISTORY_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch {
    // The live application snapshot remains available when storage is blocked.
  }
}

export function clearApplicationImpactHistory(
  storage: Storage = window.localStorage,
): void {
  try {
    storage.removeItem(APPLICATION_IMPACT_HISTORY_STORAGE_KEY);
  } catch {
    // Clearing the in-memory copy remains useful when storage is unavailable.
  }
}

export function mergeApplicationImpactHistory(
  current: readonly ApplicationImpactHistoryPoint[],
  applications: readonly ApplicationImpact[],
  sampledAtMs: number,
): ApplicationImpactHistoryPoint[] {
  const cutoff = sampledAtMs - APPLICATION_IMPACT_HISTORY_RETENTION_MS;
  const bucketStartMs =
    Math.floor(sampledAtMs / APPLICATION_IMPACT_HISTORY_BUCKET_MS)
    * APPLICATION_IMPACT_HISTORY_BUCKET_MS;
  const points = current
    .filter((point) => point.sampledAtMs >= cutoff)
    .map((point) => ({ ...point, applications: [...point.applications] }));
  const index = points.findIndex((point) => point.bucketStartMs === bucketStartMs);
  const nextApplications = applications
    .filter((application) => application.name.trim().length > 0)
    .map(entryFromApplication);

  if (index >= 0) {
    points[index] = mergePoint(points[index]!, nextApplications, sampledAtMs);
  } else {
    points.push({
      bucketStartMs,
      sampledAtMs,
      sampleCount: 1,
      applications: rankEntries(nextApplications),
    });
  }
  return points
    .sort((left, right) => left.bucketStartMs - right.bucketStartMs)
    .filter((point) => point.sampledAtMs >= cutoff);
}

export function applicationImpactHistoryInRange(
  points: readonly ApplicationImpactHistoryPoint[],
  hours: ApplicationImpactHistoryRangeHours,
  now = Date.now(),
): ApplicationImpactHistoryPoint[] {
  const cutoff = now - hours * 60 * 60 * 1_000;
  return points.filter((point) =>
    point.sampledAtMs >= cutoff && point.sampledAtMs <= now
  );
}

export function summarizeApplicationImpactHistory(
  points: readonly ApplicationImpactHistoryPoint[],
): ApplicationImpactHistoryEntry[] {
  const entries = new Map<string, ApplicationImpactHistoryEntry>();
  for (const point of points) {
    for (const application of point.applications) {
      const current = entries.get(application.applicationId);
      entries.set(
        application.applicationId,
        current ? mergeEntries(current, application) : { ...application },
      );
    }
  }
  return rankEntries([...entries.values()]);
}

export function applicationImpactDelta(
  current: ApplicationImpactHistoryEntry,
  previous: ApplicationImpactHistoryEntry | undefined,
): number | null {
  if (!previous || previous.averageCpuPercent <= 0) return null;
  return (
    (current.averageCpuPercent - previous.averageCpuPercent)
    / previous.averageCpuPercent
  ) * 100;
}

function mergePoint(
  point: ApplicationImpactHistoryPoint,
  incoming: readonly ApplicationImpactHistoryEntry[],
  sampledAtMs: number,
): ApplicationImpactHistoryPoint {
  const applications = new Map(
    point.applications.map((entry) => [entry.applicationId, entry]),
  );
  for (const entry of incoming) {
    const current = applications.get(entry.applicationId);
    applications.set(
      entry.applicationId,
      current ? mergeEntries(current, entry) : entry,
    );
  }
  return {
    ...point,
    sampledAtMs: Math.max(point.sampledAtMs, sampledAtMs),
    sampleCount: point.sampleCount + 1,
    applications: rankEntries([...applications.values()]),
  };
}

function mergeEntries(
  previous: ApplicationImpactHistoryEntry,
  next: ApplicationImpactHistoryEntry,
): ApplicationImpactHistoryEntry {
  const sampleCount = previous.sampleCount + next.sampleCount;
  return {
    ...previous,
    name: next.name || previous.name,
    sampleCount,
    averageCpuPercent: weightedAverage(
      previous.averageCpuPercent,
      previous.sampleCount,
      next.averageCpuPercent,
      next.sampleCount,
    ),
    peakCpuPercent: Math.max(previous.peakCpuPercent, next.peakCpuPercent),
    averageMemoryBytes: weightedAverage(
      previous.averageMemoryBytes,
      previous.sampleCount,
      next.averageMemoryBytes,
      next.sampleCount,
    ),
    peakMemoryBytes: Math.max(previous.peakMemoryBytes, next.peakMemoryBytes),
    averageDiskBytesPerSecond: weightedAverage(
      previous.averageDiskBytesPerSecond,
      previous.sampleCount,
      next.averageDiskBytesPerSecond,
      next.sampleCount,
    ),
    peakDiskBytesPerSecond: Math.max(
      previous.peakDiskBytesPerSecond,
      next.peakDiskBytesPerSecond,
    ),
  };
}

function entryFromApplication(
  application: ApplicationImpact,
): ApplicationImpactHistoryEntry {
  return {
    applicationId: stableApplicationId(application.id),
    name: application.name.trim().slice(0, 120),
    sampleCount: 1,
    averageCpuPercent: Math.max(0, application.cpuPercent),
    peakCpuPercent: Math.max(0, application.cpuPercent),
    averageMemoryBytes: Math.max(0, application.memoryBytes),
    peakMemoryBytes: Math.max(0, application.memoryBytes),
    averageDiskBytesPerSecond: Math.max(0, application.diskBytesPerSecond),
    peakDiskBytesPerSecond: Math.max(0, application.diskBytesPerSecond),
  };
}

function stableApplicationId(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `app-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function rankEntries(
  entries: readonly ApplicationImpactHistoryEntry[],
): ApplicationImpactHistoryEntry[] {
  return [...entries]
    .sort((left, right) =>
      impactScore(right) - impactScore(left)
      || left.name.localeCompare(right.name)
    )
    .slice(0, APPLICATION_IMPACT_HISTORY_MAX_APPS);
}

function impactScore(entry: ApplicationImpactHistoryEntry): number {
  return entry.peakCpuPercent * 1_000_000
    + entry.peakDiskBytesPerSecond
    + entry.peakMemoryBytes / 16;
}

function weightedAverage(
  left: number,
  leftCount: number,
  right: number,
  rightCount: number,
): number {
  return (left * leftCount + right * rightCount) / (leftCount + rightCount);
}

function isApplicationImpactHistoryPoint(
  value: unknown,
): value is ApplicationImpactHistoryPoint {
  if (!isRecord(value) || !Array.isArray(value.applications)) return false;
  return finite(value.bucketStartMs)
    && finite(value.sampledAtMs)
    && finite(value.sampleCount)
    && value.applications.every(isApplicationImpactHistoryEntry);
}

function isApplicationImpactHistoryEntry(
  value: unknown,
): value is ApplicationImpactHistoryEntry {
  if (!isRecord(value)) return false;
  return typeof value.applicationId === "string"
    && value.applicationId.length > 0
    && typeof value.name === "string"
    && value.name.length > 0
    && finite(value.sampleCount)
    && finite(value.averageCpuPercent)
    && finite(value.peakCpuPercent)
    && finite(value.averageMemoryBytes)
    && finite(value.peakMemoryBytes)
    && finite(value.averageDiskBytesPerSecond)
    && finite(value.peakDiskBytesPerSecond);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
