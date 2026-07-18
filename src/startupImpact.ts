import type { ApplicationImpact } from "./diagnosis";

export const STARTUP_IMPACT_STORAGE_KEY = "core-robin.startup-impact.v1";
export const STARTUP_MEASUREMENT_MAX_MS = 3 * 60 * 1_000;

export interface StartupImpactApplication {
  name: string;
  peakCpuPercent: number;
  peakMemoryBytes: number;
  peakDiskBytesPerSecond: number;
}

export interface StartupImpactMeasurement {
  launchedAtMs: number;
  completedAtMs: number;
  durationMs: number;
  settledAfterMs: number | null;
  sampleCount: number;
  peakCpuPercent: number;
  peakDiskBytesPerSecond: number;
  applications: StartupImpactApplication[];
}

export interface StartupImpactAccumulator {
  launchedAtMs: number;
  sampleCount: number;
  quietSampleCount: number;
  peakCpuPercent: number;
  peakDiskBytesPerSecond: number;
  applications: Map<string, StartupImpactApplication>;
}

export function createStartupImpactAccumulator(launchedAtMs: number): StartupImpactAccumulator {
  return {
    launchedAtMs,
    sampleCount: 0,
    quietSampleCount: 0,
    peakCpuPercent: 0,
    peakDiskBytesPerSecond: 0,
    applications: new Map(),
  };
}

export function addStartupImpactSample(
  accumulator: StartupImpactAccumulator,
  sampledAtMs: number,
  cpuPercent: number,
  diskBytesPerSecond: number,
  applications: readonly ApplicationImpact[],
): { settled: boolean; expired: boolean } {
  accumulator.sampleCount += 1;
  accumulator.peakCpuPercent = Math.max(accumulator.peakCpuPercent, cpuPercent);
  accumulator.peakDiskBytesPerSecond = Math.max(
    accumulator.peakDiskBytesPerSecond,
    diskBytesPerSecond,
  );
  accumulator.quietSampleCount = cpuPercent < 35 && diskBytesPerSecond < 10 * 1_024 * 1_024
    ? accumulator.quietSampleCount + 1
    : 0;
  for (const application of applications) {
    const current = accumulator.applications.get(application.name);
    accumulator.applications.set(application.name, {
      name: application.name,
      peakCpuPercent: Math.max(current?.peakCpuPercent ?? 0, application.cpuPercent),
      peakMemoryBytes: Math.max(current?.peakMemoryBytes ?? 0, application.memoryBytes),
      peakDiskBytesPerSecond: Math.max(
        current?.peakDiskBytesPerSecond ?? 0,
        application.diskBytesPerSecond,
      ),
    });
  }
  return {
    settled: accumulator.sampleCount >= 3 && accumulator.quietSampleCount >= 3,
    expired: sampledAtMs - accumulator.launchedAtMs >= STARTUP_MEASUREMENT_MAX_MS,
  };
}

export function completeStartupImpactMeasurement(
  accumulator: StartupImpactAccumulator,
  completedAtMs: number,
  settled: boolean,
): StartupImpactMeasurement {
  return {
    launchedAtMs: accumulator.launchedAtMs,
    completedAtMs,
    durationMs: Math.max(0, completedAtMs - accumulator.launchedAtMs),
    settledAfterMs: settled ? Math.max(0, completedAtMs - accumulator.launchedAtMs) : null,
    sampleCount: accumulator.sampleCount,
    peakCpuPercent: accumulator.peakCpuPercent,
    peakDiskBytesPerSecond: accumulator.peakDiskBytesPerSecond,
    applications: [...accumulator.applications.values()]
      .sort((left, right) =>
        right.peakCpuPercent - left.peakCpuPercent ||
        right.peakDiskBytesPerSecond - left.peakDiskBytesPerSecond ||
        right.peakMemoryBytes - left.peakMemoryBytes
      )
      .slice(0, 8),
  };
}

export function loadStartupImpactMeasurements(storage: Storage): StartupImpactMeasurement[] {
  try {
    const parsed = JSON.parse(storage.getItem(STARTUP_IMPACT_STORAGE_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter(isMeasurement).slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function saveStartupImpactMeasurement(
  storage: Storage,
  measurement: StartupImpactMeasurement,
): StartupImpactMeasurement[] {
  const current = loadStartupImpactMeasurements(storage)
    .filter((entry) => entry.launchedAtMs !== measurement.launchedAtMs);
  const next = [measurement, ...current].slice(0, 5);
  try {
    storage.setItem(STARTUP_IMPACT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The completed measurement remains available in React state.
  }
  return next;
}

function isMeasurement(value: unknown): value is StartupImpactMeasurement {
  if (typeof value !== "object" || value === null) return false;
  const measurement = value as Partial<StartupImpactMeasurement>;
  return typeof measurement.launchedAtMs === "number" &&
    typeof measurement.completedAtMs === "number" &&
    typeof measurement.durationMs === "number" &&
    (measurement.settledAfterMs === null || typeof measurement.settledAfterMs === "number") &&
    typeof measurement.sampleCount === "number" &&
    typeof measurement.peakCpuPercent === "number" &&
    typeof measurement.peakDiskBytesPerSecond === "number" &&
    Array.isArray(measurement.applications);
}
