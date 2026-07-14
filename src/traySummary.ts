import type { UsageThresholds } from "./settings";
import type { SystemSnapshot } from "./types";
import { memoryUsagePercent, resourceUsageLevel } from "./utils";

export type TrayHealth = "normal" | "attention" | "urgent";
export type TrayReason = "cpu" | "memory" | "storage" | "temperature" | "battery" | "none";

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
  thresholds: UsageThresholds,
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
  const candidates: Array<{ reason: TrayReason; score: number }> = [
    { reason: "cpu", score: snapshot.cpu.usagePercent ?? 0 },
    { reason: "memory", score: memoryPercent },
    { reason: "storage", score: storageUsedPercent ?? 0 },
  ];
  const temperature = snapshot.sensors.temperature.celsius;
  if (temperature !== null) candidates.push({ reason: "temperature", score: temperature });
  const battery = snapshot.sensors.battery;
  if (
    battery.present &&
    battery.chargePercent !== null &&
    battery.state === "discharging"
  ) {
    candidates.push({
      reason: "battery",
      score: battery.chargePercent <= 5 ? 100 : battery.chargePercent <= 15 ? 80 : 0,
    });
  }

  const strongest = candidates.reduce(
    (current, candidate) => candidate.score > current.score ? candidate : current,
    { reason: "none" as TrayReason, score: 0 },
  );
  const resourceLevels = [snapshot.cpu.usagePercent, memoryPercent, storageUsedPercent]
    .filter((value): value is number => value !== null)
    .map((value) => resourceUsageLevel(value, thresholds));
  const urgent =
    resourceLevels.includes("critical") ||
    (temperature !== null && temperature >= 95) ||
    (battery.present && battery.state === "discharging" && (battery.chargePercent ?? 100) <= 5);
  const attention =
    urgent ||
    resourceLevels.includes("high") ||
    (temperature !== null && temperature >= 80) ||
    (battery.present && battery.state === "discharging" && (battery.chargePercent ?? 100) <= 15);

  return {
    sampledAtMs: snapshot.sampledAtMs,
    paused,
    health: urgent ? "urgent" : attention ? "attention" : "normal",
    reason: attention ? strongest.reason : "none",
    cpuPercent: snapshot.cpu.usagePercent,
    memoryPercent,
    storageUsedPercent,
    storageAvailableBytes: volume?.availableBytes ?? null,
    temperatureCelsius: temperature,
    batteryPercent: battery.chargePercent,
    batteryState: battery.state,
  };
}
