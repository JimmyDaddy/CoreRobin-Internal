import {
  buildDailyAttentionItems,
  buildDailyStatusItems,
  type DailyAttentionItem,
  type DailyLevel,
  type DailyStatusItem,
  type DailyStatusReason,
  type DailyStatusSummary,
} from "./dailyExperience";
import { summarizeSleepBlockers } from "./deviceWellbeing";
import {
  DIAGNOSIS_CONNECTION_COUNT_THRESHOLD,
  type SmartDiagnosisResult,
} from "./diagnosis";
import { volumeUsage } from "./storageExplorer";
import type {
  NetworkConnectionsSnapshot,
  SystemHealthSnapshot,
} from "./types";

const MEBIBYTE = 1_024 ** 2;
const GIBIBYTE = 1_024 ** 3;

export const DAILY_INCIDENT_CONFIRMATION_MS = 10_000;
export const DAILY_INCIDENT_URGENT_TEMPERATURE_CONFIRMATION_MS = 3_000;
export const DAILY_INCIDENT_RECOVERY_MS = 30_000;
export const DAILY_INCIDENT_BATTERY_RECOVERY_MS = 10_000;
export const DAILY_INCIDENT_RESOLVED_RETENTION_MS = 5 * 60_000;

export const DAILY_INCIDENT_CPU_RECOVERY_THRESHOLD = 65;
export const DAILY_INCIDENT_DISK_RECOVERY_THRESHOLD = 35 * MEBIBYTE;
export const DAILY_INCIDENT_NETWORK_RECOVERY_THRESHOLD = 18 * MEBIBYTE;
export const DAILY_INCIDENT_CONNECTION_RECOVERY_THRESHOLD = 400;
export const DAILY_INCIDENT_TEMPERATURE_RECOVERY_CELSIUS = 70;
export const DAILY_INCIDENT_BATTERY_RECOVERY_PERCENT = 25;
export const DAILY_INCIDENT_STORAGE_RECOVERY_PERCENT = 80;
export const DAILY_INCIDENT_STORAGE_RECOVERY_AVAILABLE_BYTES = 15 * GIBIBYTE;
export const DAILY_INCIDENT_MEMORY_RECOVERY_AVAILABLE_PERCENT = 15;

export type DailyIncidentPhase = "active" | "recovering" | "resolved";

export interface DailyIncident {
  id: string;
  occurrenceId: string;
  phase: DailyIncidentPhase;
  item: DailyAttentionItem;
  peakItem: DailyAttentionItem;
  firstObservedAtMs: number;
  activatedAtMs: number;
  lastObservedAtMs: number;
  recoveryStartedAtMs: number | null;
  resolvedAtMs: number | null;
}

interface DailyIncidentTracker extends Omit<DailyIncident, "phase"> {
  phase: DailyIncidentPhase | "pending";
}

export interface DailyIncidentEvaluationState {
  trackers: Record<string, DailyIncidentTracker>;
}

export interface DailyIncidentEvaluationInput {
  diagnosis: SmartDiagnosisResult;
  snapshot: SystemHealthSnapshot;
  connections: NetworkConnectionsSnapshot | null;
}

export interface DailyIncidentTiming {
  confirmationMs: number;
  urgentTemperatureConfirmationMs: number;
  recoveryMs: number;
  batteryRecoveryMs: number;
  resolvedRetentionMs: number;
}

const DEFAULT_TIMING: DailyIncidentTiming = {
  confirmationMs: DAILY_INCIDENT_CONFIRMATION_MS,
  urgentTemperatureConfirmationMs:
    DAILY_INCIDENT_URGENT_TEMPERATURE_CONFIRMATION_MS,
  recoveryMs: DAILY_INCIDENT_RECOVERY_MS,
  batteryRecoveryMs: DAILY_INCIDENT_BATTERY_RECOVERY_MS,
  resolvedRetentionMs: DAILY_INCIDENT_RESOLVED_RETENTION_MS,
};

export function createDailyIncidentEvaluationState(): DailyIncidentEvaluationState {
  return { trackers: {} };
}

export function evaluateDailyIncidents(
  current: DailyIncidentEvaluationState,
  input: DailyIncidentEvaluationInput,
  timing: Partial<DailyIncidentTiming> = {},
): DailyIncidentEvaluationState {
  const options = { ...DEFAULT_TIMING, ...timing };
  const sampledAtMs = Math.max(
    input.snapshot.sampledAtMs,
    input.connections?.sampledAtMs ?? 0,
  );
  const maximumGapMs = Math.max(
    15_000,
    input.snapshot.sampleIntervalMs * 3,
  );
  const observedItems = buildDailyAttentionItems(
    input.diagnosis,
    input.snapshot,
  );
  const observedIds = new Set(observedItems.map(({ id }) => id));
  const trackers = { ...current.trackers };

  for (const item of observedItems) {
    const existing = trackers[item.id];
    if (!existing || existing.phase === "resolved") {
      const tracker = createPendingTracker(item, sampledAtMs);
      trackers[item.id] = activateIfReady(tracker, sampledAtMs, options);
      continue;
    }

    const candidateInterrupted =
      existing.phase === "pending" &&
      sampledAtMs - existing.lastObservedAtMs > maximumGapMs;
    if (candidateInterrupted) {
      const tracker = createPendingTracker(item, sampledAtMs);
      trackers[item.id] = activateIfReady(tracker, sampledAtMs, options);
      continue;
    }

    const next: DailyIncidentTracker = {
      ...existing,
      phase: existing.phase === "pending" ? "pending" : "active",
      item,
      peakItem: strongerItem(existing.peakItem, item),
      lastObservedAtMs: sampledAtMs,
      recoveryStartedAtMs: null,
      resolvedAtMs: null,
    };
    trackers[item.id] = activateIfReady(next, sampledAtMs, options);
  }

  for (const [id, existing] of Object.entries(trackers)) {
    if (observedIds.has(id)) continue;
    if (existing.phase === "pending") {
      delete trackers[id];
      continue;
    }
    if (existing.phase === "resolved") {
      if (
        existing.resolvedAtMs !== null &&
        sampledAtMs - existing.resolvedAtMs >= options.resolvedRetentionMs
      ) {
        delete trackers[id];
      }
      continue;
    }

    const recoverySignal = recoverySignalFor(existing.item, input);
    if (recoverySignal === "hold") {
      trackers[id] = {
        ...existing,
        phase: "active",
        recoveryStartedAtMs: null,
      };
      continue;
    }

    const recoveryStartedAtMs = existing.recoveryStartedAtMs ?? sampledAtMs;
    const recoveryDurationMs = recoveryDurationFor(existing.item, options);
    if (sampledAtMs - recoveryStartedAtMs < recoveryDurationMs) {
      trackers[id] = {
        ...existing,
        phase: "recovering",
        recoveryStartedAtMs,
      };
      continue;
    }
    trackers[id] = {
      ...existing,
      phase: "resolved",
      recoveryStartedAtMs,
      resolvedAtMs: sampledAtMs,
    };
  }

  return { trackers };
}

export function activeDailyIncidents(
  state: DailyIncidentEvaluationState,
): DailyIncident[] {
  return Object.values(state.trackers)
    .filter((tracker): tracker is DailyIncidentTracker & { phase: "active" | "recovering" } =>
      tracker.phase === "active" || tracker.phase === "recovering")
    .sort(compareIncidents);
}

export function retainedDailyIncidents(
  state: DailyIncidentEvaluationState,
): DailyIncident[] {
  return Object.values(state.trackers)
    .filter((tracker): tracker is DailyIncidentTracker & { phase: DailyIncidentPhase } =>
      tracker.phase !== "pending")
    .sort(compareIncidents);
}

export function pendingDailyIncidentCount(
  state: DailyIncidentEvaluationState,
): number {
  return Object.values(state.trackers).filter(({ phase }) => phase === "pending").length;
}

export function dailyIncidentLevel(
  incidents: readonly DailyIncident[],
  baselineReady: boolean,
  pendingCount = 0,
): DailyLevel {
  if (incidents.some((incident) =>
    incident.phase === "active" && incident.item.level === "urgent")) {
    return "urgent";
  }
  if (incidents.length > 0) return "attention";
  return baselineReady && pendingCount === 0 ? "normal" : "observing";
}

export function dailyIncidentStatusSummary(
  incidents: readonly DailyIncident[],
  baselineReady: boolean,
  pendingCount = 0,
): DailyStatusSummary {
  const level = dailyIncidentLevel(incidents, baselineReady, pendingCount);
  const primary = incidents[0] ?? null;
  return {
    level,
    reason: primary ? reasonFor(primary.item) : "none",
  };
}

export function buildStableDailyStatusItems(
  incidents: readonly DailyIncident[],
  diagnosis: SmartDiagnosisResult,
  snapshot: SystemHealthSnapshot,
): DailyStatusItem[] {
  return buildDailyStatusItems(diagnosis, snapshot).map((base) => {
    const matching = incidents.filter((incident) => incidentMatchesStatus(incident, base.kind));
    if (matching.length > 0) {
      const level = matching.reduce<"attention" | "urgent">(
        (strongest, incident) =>
          levelRank(dailyIncidentDisplayLevel(incident)) > levelRank(strongest)
            ? dailyIncidentDisplayLevel(incident)
            : strongest,
        "attention",
      );
      return { ...base, level };
    }
    if (base.level === "unavailable") return base;
    return {
      ...base,
      level: base.kind === "speed" && !diagnosis.baselineReady
        ? "observing"
        : "normal",
    };
  });
}

export function dailyIncidentDisplayLevel(
  incident: DailyIncident,
): "attention" | "urgent" {
  return incident.phase === "active" ? incident.item.level : "attention";
}

function createPendingTracker(
  item: DailyAttentionItem,
  sampledAtMs: number,
): DailyIncidentTracker {
  return {
    id: item.id,
    occurrenceId: `${item.id}:${sampledAtMs}`,
    phase: "pending",
    item,
    peakItem: item,
    firstObservedAtMs: sampledAtMs,
    activatedAtMs: sampledAtMs,
    lastObservedAtMs: sampledAtMs,
    recoveryStartedAtMs: null,
    resolvedAtMs: null,
  };
}

function activateIfReady(
  tracker: DailyIncidentTracker,
  sampledAtMs: number,
  timing: DailyIncidentTiming,
): DailyIncidentTracker {
  if (tracker.phase !== "pending") return tracker;
  const confirmationMs = confirmationDurationFor(tracker.item, timing);
  if (sampledAtMs - tracker.firstObservedAtMs < confirmationMs) return tracker;
  return {
    ...tracker,
    phase: "active",
    activatedAtMs: sampledAtMs,
  };
}

function confirmationDurationFor(
  item: DailyAttentionItem,
  timing: DailyIncidentTiming,
): number {
  if (item.kind === "battery" || item.kind === "sleep") return 0;
  if (item.kind === "temperature") {
    return item.level === "urgent"
      ? timing.urgentTemperatureConfirmationMs
      : timing.confirmationMs;
  }
  if (item.finding.code === "low_storage") return 0;
  if (
    item.finding.code === "memory_pressure" &&
    item.finding.severity === "urgent" &&
    item.finding.durationMs === 0
  ) return 0;
  return timing.confirmationMs;
}

function recoveryDurationFor(
  item: DailyAttentionItem,
  timing: DailyIncidentTiming,
): number {
  return item.kind === "battery" ? timing.batteryRecoveryMs : timing.recoveryMs;
}

function recoverySignalFor(
  item: DailyAttentionItem,
  { diagnosis, snapshot, connections }: DailyIncidentEvaluationInput,
): "hold" | "recover" {
  if (item.kind === "temperature") {
    const celsius = snapshot.sensors.temperature.celsius;
    return celsius !== null &&
      Number.isFinite(celsius) &&
      celsius <= DAILY_INCIDENT_TEMPERATURE_RECOVERY_CELSIUS
      ? "recover"
      : "hold";
  }
  if (item.kind === "battery") {
    const battery = snapshot.sensors.battery;
    if (!battery.present || battery.chargePercent === null) return "hold";
    return battery.state !== "discharging" ||
      battery.chargePercent > DAILY_INCIDENT_BATTERY_RECOVERY_PERCENT
      ? "recover"
      : "hold";
  }
  if (item.kind === "sleep") {
    if (!snapshot.sensors.sleep.available) return "hold";
    const hasUserBlocker = summarizeSleepBlockers(
      snapshot.sensors.sleep,
      diagnosis.applications,
    ).some(({ systemComponent }) => !systemComponent);
    return hasUserBlocker ? "hold" : "recover";
  }

  switch (item.finding.code) {
    case "sustained_cpu": {
      const value = snapshot.cpu.usagePercent;
      return value !== null && value < DAILY_INCIDENT_CPU_RECOVERY_THRESHOLD
        ? "recover"
        : "hold";
    }
    case "memory_pressure": {
      if (snapshot.memory.totalBytes <= 0) return "hold";
      const availablePercent = Math.max(
        0,
        snapshot.memory.availableBytes / snapshot.memory.totalBytes * 100,
      );
      return availablePercent >= DAILY_INCIDENT_MEMORY_RECOVERY_AVAILABLE_PERCENT
        ? "recover"
        : "hold";
    }
    case "low_storage": {
      const volumes = snapshot.disk.volumes
        .filter(({ totalBytes }) => totalBytes >= 4 * GIBIBYTE)
        .map(volumeUsage);
      if (volumes.length === 0) return "hold";
      return volumes.every(({ usagePercent, volume }) =>
        usagePercent < DAILY_INCIDENT_STORAGE_RECOVERY_PERCENT &&
        volume.availableBytes > DAILY_INCIDENT_STORAGE_RECOVERY_AVAILABLE_BYTES)
        ? "recover"
        : "hold";
    }
    case "busy_disk": {
      const read = snapshot.disk.readBytesPerSecond;
      const write = snapshot.disk.writeBytesPerSecond;
      return read !== null &&
        write !== null &&
        read + write < DAILY_INCIDENT_DISK_RECOVERY_THRESHOLD
        ? "recover"
        : "hold";
    }
    case "high_network": {
      const received = snapshot.network.receivedBytesPerSecond;
      const transmitted = snapshot.network.transmittedBytesPerSecond;
      if (received === null || transmitted === null) return "hold";
      const trafficRecovered =
        received + transmitted < DAILY_INCIDENT_NETWORK_RECOVERY_THRESHOLD;
      const connectionTriggered =
        item.finding.durationMs === 0 &&
        (item.finding.secondaryValue ?? 0) >= DIAGNOSIS_CONNECTION_COUNT_THRESHOLD;
      if (connectionTriggered && !connections) return "hold";
      const connectionsRecovered = !connections ||
        connections.summary.totalCount < DAILY_INCIDENT_CONNECTION_RECOVERY_THRESHOLD;
      return trafficRecovered && connectionsRecovered ? "recover" : "hold";
    }
  }
}

function strongerItem(
  current: DailyAttentionItem,
  candidate: DailyAttentionItem,
): DailyAttentionItem {
  return levelRank(candidate.level) > levelRank(current.level)
    ? candidate
    : current;
}

function compareIncidents(left: DailyIncident, right: DailyIncident): number {
  const phaseDifference = phaseRank(right.phase) - phaseRank(left.phase);
  if (phaseDifference !== 0) return phaseDifference;
  const levelDifference =
    levelRank(dailyIncidentDisplayLevel(right)) -
    levelRank(dailyIncidentDisplayLevel(left));
  return levelDifference ||
    left.activatedAtMs - right.activatedAtMs ||
    left.id.localeCompare(right.id);
}

function phaseRank(phase: DailyIncidentPhase): number {
  if (phase === "active") return 2;
  if (phase === "recovering") return 1;
  return 0;
}

function levelRank(level: "attention" | "urgent"): number {
  return level === "urgent" ? 2 : 1;
}

function reasonFor(item: DailyAttentionItem): DailyStatusReason {
  if (item.kind === "temperature" || item.kind === "battery") return item.kind;
  if (item.kind === "sleep") return "sleep";
  if (item.finding.category === "storage") return "storage";
  if (item.finding.category === "memory") return "memory";
  if (item.finding.category === "network") return "network";
  return "cpu";
}

function incidentMatchesStatus(
  incident: DailyIncident,
  kind: DailyStatusItem["kind"],
): boolean {
  if (kind === "temperature") return incident.item.kind === "temperature";
  if (kind === "battery") return incident.item.kind === "battery";
  if (incident.item.kind !== "diagnosis") return false;
  if (kind === "space") return incident.item.finding.category === "storage";
  return kind === "speed" && incident.item.finding.category !== "storage";
}
