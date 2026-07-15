import {
  buildDailyStatusSummary,
  type DailyStatusReason,
} from "./dailyExperience";
import type { SmartDiagnosisResult } from "./diagnosis";
import type { SystemSnapshot, SystemSummary } from "./types";
import { memoryUsagePercent } from "./utils";

export type TrayHealth = "observing" | "normal" | "attention" | "urgent";
export type TrayReason = DailyStatusReason;

export interface TraySummary {
  sampledAtMs: number;
  paused: boolean;
  health: TrayHealth;
  reason: TrayReason;
  cpuPercent: number | null;
  memoryPercent: number;
  storageUsedPercent: number | null;
  storageAvailableBytes: number | null;
  temperatureCelsius: number | null;
  batteryPercent: number | null;
  batteryState: SystemSnapshot["sensors"]["battery"]["state"];
}

export function buildTraySummary(
  snapshot: SystemSnapshot,
  paused: boolean,
  diagnosis: SmartDiagnosisResult,
): TraySummary {
  const memoryPercent = memoryUsagePercent(
    snapshot.memory.usedBytes,
    snapshot.memory.totalBytes,
  );
  const volume =
    snapshot.disk.volumes.find(({ mountPoint }) => mountPoint === "/") ??
    snapshot.disk.volumes[0] ??
    null;
  const storageUsedPercent = volume && volume.totalBytes > 0
    ? ((volume.totalBytes - volume.availableBytes) / volume.totalBytes) * 100
    : null;
  const temperature = snapshot.sensors.temperature.celsius;
  const battery = snapshot.sensors.battery;
  const status = buildDailyStatusSummary(diagnosis, snapshot);

  return {
    sampledAtMs: snapshot.sampledAtMs,
    paused,
    health: status.level,
    reason: status.reason,
    cpuPercent: snapshot.cpu.usagePercent,
    memoryPercent,
    storageUsedPercent,
    storageAvailableBytes: volume?.availableBytes ?? null,
    temperatureCelsius: temperature,
    batteryPercent: battery.chargePercent,
    batteryState: battery.state,
  };
}

export function buildLightTraySummary(
  summary: SystemSummary,
  paused: boolean,
  previous: TraySummary | null,
): TraySummary {
  const memoryPercent = memoryUsagePercent(
    summary.memory.usedBytes,
    summary.memory.totalBytes,
  );
  const volume =
    summary.volumes.find(({ mountPoint }) => mountPoint === "/") ??
    summary.volumes[0] ??
    null;
  const storageUsedPercent = volume && volume.totalBytes > 0
    ? ((volume.totalBytes - volume.availableBytes) / volume.totalBytes) * 100
    : null;

  return {
    sampledAtMs: summary.sampledAtMs,
    paused,
    health: previous?.health ?? "observing",
    reason: previous?.reason ?? "none",
    cpuPercent: summary.cpu.usagePercent,
    memoryPercent,
    storageUsedPercent,
    storageAvailableBytes: volume?.availableBytes ?? null,
    temperatureCelsius: summary.sensors.temperature.celsius,
    batteryPercent: summary.sensors.battery.chargePercent,
    batteryState: summary.sensors.battery.state,
  };
}
