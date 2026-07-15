import {
  buildDailyStatusSummary,
  type DailyStatusReason,
} from "./dailyExperience";
import type { SmartDiagnosisResult } from "./diagnosis";
import type { SystemSnapshot } from "./types";
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
