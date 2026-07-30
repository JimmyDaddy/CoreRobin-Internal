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

interface LegacyStoredApplicationImpactHistory {
  version: 1;
  points: ApplicationImpactHistoryPoint[];
}

type CompactApplicationEntry = [
  applicationIndex: number,
  sampleCount: number,
  averageCpuPercent: number,
  peakCpuPercent: number,
  averageMemoryBytes: number,
  peakMemoryBytes: number,
  averageDiskBytesPerSecond: number,
  peakDiskBytesPerSecond: number,
];

type CompactApplicationPoint = [
  bucketStartMs: number,
  sampledAtMs: number,
  sampleCount: number,
  applications: CompactApplicationEntry[],
];

interface StoredApplicationImpactHistory {
  version: 2;
  applications: [applicationId: string, name: string][];
  points: CompactApplicationPoint[];
}

export interface ApplicationImpactHistorySaveResult {
  succeeded: boolean;
  byteSize: number;
  error: string | null;
}

export function loadApplicationImpactHistory(
  storage: Storage = window.localStorage,
): ApplicationImpactHistoryPoint[] {
  try {
    return parseApplicationImpactHistory(
      storage.getItem(APPLICATION_IMPACT_HISTORY_STORAGE_KEY),
    );
  } catch {
    return [];
  }
}

export function saveApplicationImpactHistory(
  points: readonly ApplicationImpactHistoryPoint[],
  storage: Storage = window.localStorage,
): ApplicationImpactHistorySaveResult {
  const payload = serializeApplicationImpactHistory(points);
  const byteSize = new TextEncoder().encode(payload).byteLength;
  try {
    storage.setItem(APPLICATION_IMPACT_HISTORY_STORAGE_KEY, payload);
    return { succeeded: true, byteSize, error: null };
  } catch (reason) {
    return {
      succeeded: false,
      byteSize,
      error:
        typeof reason === "object" &&
        reason !== null &&
        "message" in reason &&
        typeof reason.message === "string"
          ? reason.message
          : String(reason),
    };
  }
}

export function serializeApplicationImpactHistory(
  points: readonly ApplicationImpactHistoryPoint[],
): string {
  const applications: StoredApplicationImpactHistory["applications"] = [];
  const indexes = new Map<string, number>();
  const compactPoints: CompactApplicationPoint[] = points.map((point) => [
    point.bucketStartMs,
    point.sampledAtMs,
    point.sampleCount,
    point.applications.map((application) => {
      const identity = `${application.applicationId}\u0000${application.name}`;
      let applicationIndex = indexes.get(identity);
      if (applicationIndex === undefined) {
        applicationIndex = applications.length;
        indexes.set(identity, applicationIndex);
        applications.push([application.applicationId, application.name]);
      }
      return [
        applicationIndex,
        application.sampleCount,
        application.averageCpuPercent,
        application.peakCpuPercent,
        application.averageMemoryBytes,
        application.peakMemoryBytes,
        application.averageDiskBytesPerSecond,
        application.peakDiskBytesPerSecond,
      ];
    }),
  ]);
  return JSON.stringify({ version: 2, applications, points: compactPoints });
}

export function parseApplicationImpactHistory(
  payload: string | null,
): ApplicationImpactHistoryPoint[] {
  if (!payload) return [];
  try {
    const value = JSON.parse(payload) as unknown;
    if (!isRecord(value) || !Array.isArray(value.points)) return [];
    if (value.version === 1) {
      return (value as unknown as LegacyStoredApplicationImpactHistory).points
        .filter(isApplicationImpactHistoryPoint)
        .sort((left, right) => left.bucketStartMs - right.bucketStartMs);
    }
    if (value.version !== 2 || !Array.isArray(value.applications)) return [];
    const applicationDictionary = value.applications
      .map((application) =>
        Array.isArray(application)
          && typeof application[0] === "string"
          && typeof application[1] === "string"
          ? [application[0], application[1]] as const
          : null
      );
    return value.points
      .map((point) => compactPoint(point, applicationDictionary))
      .filter((point): point is ApplicationImpactHistoryPoint => point !== null)
      .sort((left, right) => left.bucketStartMs - right.bucketStartMs);
  } catch {
    return [];
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

export function applicationImpactHistoryForDisplay(
  points: readonly ApplicationImpactHistoryPoint[],
  hours: ApplicationImpactHistoryRangeHours,
): ApplicationImpactHistoryPoint[] {
  const displayBucketMs = timeSeriesBucketMs(hours);
  const buckets = new Map<number, ApplicationImpactHistoryPoint>();
  for (const point of points) {
    const bucketStartMs =
      Math.floor(point.sampledAtMs / displayBucketMs) * displayBucketMs;
    const previous = buckets.get(bucketStartMs);
    buckets.set(
      bucketStartMs,
      previous
        ? mergeDisplayPoints(previous, point, bucketStartMs)
        : { ...point, bucketStartMs },
    );
  }
  return [...buckets.values()].sort(
    (left, right) => left.bucketStartMs - right.bucketStartMs,
  );
}

export function applicationImpactPointScore(
  point: ApplicationImpactHistoryPoint,
): number {
  return point.applications.reduce(
    (total, application) => total + impactScore(application),
    0,
  );
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

function mergeDisplayPoints(
  left: ApplicationImpactHistoryPoint,
  right: ApplicationImpactHistoryPoint,
  bucketStartMs: number,
): ApplicationImpactHistoryPoint {
  const applications = new Map(
    left.applications.map((application) => [
      application.applicationId,
      application,
    ]),
  );
  for (const application of right.applications) {
    const previous = applications.get(application.applicationId);
    applications.set(
      application.applicationId,
      previous ? mergeEntries(previous, application) : application,
    );
  }
  return {
    bucketStartMs,
    sampledAtMs: Math.max(left.sampledAtMs, right.sampledAtMs),
    sampleCount: left.sampleCount + right.sampleCount,
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
    applicationId: stableApplicationId(application.applicationId ?? application.id),
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
  return `app-${[
    2_166_136_261,
    2_166_136_261 ^ 0x9e37_79b9,
    2_166_136_261 ^ 0x85eb_ca6b,
    2_166_136_261 ^ 0xc2b2_ae35,
  ].map((seed) => fnv32(value, seed)).join("")}`;
}

function fnv32(value: string, seed: number): string {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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

function compactPoint(
  value: unknown,
  applications: readonly (readonly [string, string] | null)[],
): ApplicationImpactHistoryPoint | null {
  if (
    !Array.isArray(value)
    || !finite(value[0])
    || !finite(value[1])
    || !finite(value[2])
    || !Array.isArray(value[3])
  ) return null;
  const entries = value[3].map((entry): ApplicationImpactHistoryEntry | null => {
    if (
      !Array.isArray(entry)
      || entry.length !== 8
      || !Number.isInteger(entry[0])
      || entry.slice(1).some((item) => !finite(item))
    ) return null;
    const application = applications[entry[0] as number];
    if (!application) return null;
    return {
      applicationId: application[0],
      name: application[1],
      sampleCount: entry[1] as number,
      averageCpuPercent: entry[2] as number,
      peakCpuPercent: entry[3] as number,
      averageMemoryBytes: entry[4] as number,
      peakMemoryBytes: entry[5] as number,
      averageDiskBytesPerSecond: entry[6] as number,
      peakDiskBytesPerSecond: entry[7] as number,
    };
  });
  if (entries.some((entry) => entry === null)) return null;
  return {
    bucketStartMs: value[0],
    sampledAtMs: value[1],
    sampleCount: value[2],
    applications: entries as ApplicationImpactHistoryEntry[],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
import { timeSeriesBucketMs } from "./timeSeries";
