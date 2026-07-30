import type {
  DailyIntent,
  DailyStatusReason,
} from "./dailyExperience";
import {
  dailyIncidentDisplayLevel,
  dailyIncidentStatusSummary,
  type DailyIncident,
  type DailyIncidentPhase,
} from "./dailyIncidents";
import type {
  SystemHealthSnapshot,
  SystemSnapshot,
} from "./types";
import { memoryUsagePercent } from "./utils";

export const HEALTH_STATE_SCHEMA_VERSION = 3;
export const HEALTH_STATE_EVENT = "core-robin:health-state-changed";

export type HealthLevel = "observing" | "normal" | "attention" | "urgent";
export type HealthDataMode = "foreground" | "background";
export type HealthDataStatus = "fresh" | "paused" | "stale";

export interface HealthIncidentProjection {
  id: string;
  occurrenceId: string;
  phase: DailyIncidentPhase;
  level: "attention" | "urgent";
  reason: DailyStatusReason;
  intent: DailyIntent;
  activatedAtMs: number;
  recoveryStartedAtMs: number | null;
}

export interface HealthStateUpdate {
  schemaVersion: typeof HEALTH_STATE_SCHEMA_VERSION;
  sampledAtMs: number;
  dataMode: HealthDataMode;
  dataStatus: HealthDataStatus;
  paused: boolean;
  health: HealthLevel;
  reason: DailyStatusReason;
  activeCount: number;
  pendingCount: number;
  recoveringCount: number;
  primaryIncident: HealthIncidentProjection | null;
  cpuPercent: number | null;
  memoryPercent: number;
  storageUsedPercent: number | null;
  storageAvailableBytes: number | null;
  temperatureCelsius: number | null;
  batteryPercent: number | null;
  batteryHealthPercent: number | null;
  batteryCycleCount: number | null;
  batteryState: SystemSnapshot["sensors"]["battery"]["state"];
}

export interface HealthStateSnapshot extends HealthStateUpdate {
  revision: number;
}

export function buildHealthStateUpdate(
  snapshot: SystemHealthSnapshot,
  paused: boolean,
  incidents: readonly DailyIncident[],
  pendingCount: number,
  baselineReady: boolean,
  dataMode: HealthDataMode,
): HealthStateUpdate {
  const status = dailyIncidentStatusSummary(
    incidents,
    baselineReady,
    pendingCount,
  );
  const primary = incidents[0] ?? null;
  const volume =
    snapshot.disk.volumes.find(({ mountPoint }) => mountPoint === "/") ??
    snapshot.disk.volumes[0] ??
    null;
  const storageUsedPercent = volume && volume.totalBytes > 0
    ? ((volume.totalBytes - volume.availableBytes) / volume.totalBytes) * 100
    : null;

  return {
    schemaVersion: HEALTH_STATE_SCHEMA_VERSION,
    sampledAtMs: snapshot.sampledAtMs,
    dataMode,
    dataStatus: paused ? "paused" : "fresh",
    paused,
    health: status.level,
    reason: status.reason,
    activeCount: incidents.length,
    pendingCount,
    recoveringCount: incidents.filter(({ phase }) => phase === "recovering").length,
    primaryIncident: primary
      ? {
          id: primary.id,
          occurrenceId: primary.occurrenceId,
          phase: primary.phase,
          level: dailyIncidentDisplayLevel(primary),
          reason: status.reason,
          intent: primary.item.intent,
          activatedAtMs: primary.activatedAtMs,
          recoveryStartedAtMs: primary.recoveryStartedAtMs,
        }
      : null,
    cpuPercent: snapshot.cpu.usagePercent,
    memoryPercent: memoryUsagePercent(
      snapshot.memory.usedBytes,
      snapshot.memory.totalBytes,
    ),
    storageUsedPercent,
    storageAvailableBytes: volume?.availableBytes ?? null,
    temperatureCelsius: snapshot.sensors.temperature.celsius,
    batteryPercent: snapshot.sensors.battery.chargePercent,
    batteryHealthPercent: snapshot.sensors.battery.healthPercent,
    batteryCycleCount: snapshot.sensors.battery.cycleCount,
    batteryState: snapshot.sensors.battery.state,
  };
}

export function selectNewerHealthState(
  current: HealthStateSnapshot | null,
  candidate: HealthStateSnapshot | null,
): HealthStateSnapshot | null {
  if (!candidate) return current;
  if (!current || candidate.revision > current.revision) return candidate;
  return current;
}
