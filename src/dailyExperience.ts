import {
  applicationImpactLevel,
  applicationPrimaryResource,
  type ApplicationImpactLevel,
  type ApplicationPrimaryResource,
} from "./applicationImpact";
import {
  batteryWellbeingLevel,
  summarizeSleepBlockers,
  temperatureWellbeingLevel,
} from "./deviceWellbeing";
import type {
  ApplicationImpact,
  DiagnosisFinding,
  SmartDiagnosisResult,
} from "./diagnosis";
import { volumeUsage, type VolumeUsage } from "./storageExplorer";
import type {
  CleanupScan,
  ProcessActionOutcome,
  SensorsSnapshot,
  SystemHealthSnapshot,
} from "./types";

const GIBIBYTE = 1_024 ** 3;

export const DAILY_SLEEP_BLOCKER_MIN_DURATION_SECONDS = 120;

export const DAILY_INTENTS = [
  "slow",
  "space",
  "startup",
  "heat",
  "network",
  "checkup",
] as const;
export type DailyIntent = (typeof DAILY_INTENTS)[number];
export type DailyLevel = "observing" | "normal" | "attention" | "urgent";
export type DailyOrbitLevel = DailyLevel | "unavailable";
export type DailyOrbitKind = "speed" | "space" | "temperature" | "battery";
export type DailyStatusReason =
  | "cpu"
  | "memory"
  | "storage"
  | "temperature"
  | "battery"
  | "network"
  | "sleep"
  | "none";

export interface DailyStatusSummary {
  level: DailyLevel;
  reason: DailyStatusReason;
}

export interface DailyOrbitItem {
  kind: DailyOrbitKind;
  level: DailyOrbitLevel;
  intent: DailyIntent;
}

export type DailyAttentionItem =
  | {
      id: string;
      kind: "diagnosis";
      level: "attention" | "urgent";
      intent: DailyIntent;
      finding: DiagnosisFinding;
    }
  | {
      id: "wellbeing:temperature";
      kind: "temperature";
      level: "attention" | "urgent";
      intent: "heat";
      valueCelsius: number;
    }
  | {
      id: "wellbeing:battery";
      kind: "battery";
      level: "attention" | "urgent";
      intent: "heat";
      chargePercent: number;
    }
  | {
      id: "wellbeing:sleep";
      kind: "sleep";
      level: "attention";
      intent: "heat";
      name: string;
      durationSeconds: number;
    };

export interface DailyApplicationSummary {
  impact: ApplicationImpactLevel;
  primaryResource: ApplicationPrimaryResource;
}

export interface DailyRecheck {
  intent: DailyIntent;
  outcome: ProcessActionOutcome | "refreshed";
  checkedAtMs: number;
}

export function dailyOverallLevel(
  diagnosis: SmartDiagnosisResult,
  snapshot: SystemHealthSnapshot,
): DailyLevel {
  const sensorLevels = [
    temperatureWellbeingLevel(snapshot.sensors.temperature),
    batteryWellbeingLevel(snapshot.sensors.battery),
  ];
  const attentionLevels = buildDailyAttentionItems(diagnosis, snapshot).map(
    ({ level }) => level,
  );
  if (
    diagnosis.status === "urgent" ||
    sensorLevels.includes("urgent") ||
    attentionLevels.includes("urgent")
  ) return "urgent";
  if (
    diagnosis.status === "attention" ||
    sensorLevels.includes("attention") ||
    attentionLevels.includes("attention")
  ) {
    return "attention";
  }
  return diagnosis.status === "observing" ? "observing" : "normal";
}

export function buildDailyStatusSummary(
  diagnosis: SmartDiagnosisResult,
  snapshot: SystemHealthSnapshot,
): DailyStatusSummary {
  const level = dailyOverallLevel(diagnosis, snapshot);
  if (level === "normal" || level === "observing") {
    return { level, reason: "none" };
  }

  const primary = buildDailyAttentionItems(diagnosis, snapshot, 1)[0];
  if (!primary) return { level, reason: "none" };
  if (primary.kind === "temperature" || primary.kind === "battery") {
    return { level, reason: primary.kind };
  }
  if (primary.kind === "diagnosis") {
    const reason = primary.finding.category === "storage" ||
      primary.finding.category === "memory" ||
      primary.finding.category === "network"
      ? primary.finding.category
      : "cpu";
    return { level, reason };
  }
  return { level, reason: "sleep" };
}

export function buildDailyOrbitItems(
  diagnosis: SmartDiagnosisResult,
  snapshot: SystemHealthSnapshot,
): DailyOrbitItem[] {
  const speedFinding = strongestFinding(
    diagnosis.findings.filter(({ category }) => category !== "storage"),
  );
  const storageFinding = diagnosis.findings.find(({ category }) => category === "storage");
  const volume = primaryDailyVolume(snapshot);
  const temperature = temperatureWellbeingLevel(snapshot.sensors.temperature);
  const battery = batteryWellbeingLevel(snapshot.sensors.battery);
  return [
    {
      kind: "speed",
      level: speedFinding?.severity ?? (diagnosis.baselineReady ? "normal" : "observing"),
      intent: "slow",
    },
    {
      kind: "space",
      level: storageFinding?.severity ?? (volume ? "normal" : "unavailable"),
      intent: "space",
    },
    {
      kind: "temperature",
      level: wellbeingToDailyLevel(temperature),
      intent: "heat",
    },
    {
      kind: "battery",
      level: wellbeingToDailyLevel(battery),
      intent: "heat",
    },
  ];
}

export function buildDailyAttentionItems(
  diagnosis: SmartDiagnosisResult,
  snapshot: SystemHealthSnapshot,
  limit = Number.POSITIVE_INFINITY,
): DailyAttentionItem[] {
  const items: DailyAttentionItem[] = diagnosis.findings.map((finding) => ({
    id: `diagnosis:${finding.id}`,
    kind: "diagnosis",
    level: finding.severity,
    intent: intentForFinding(finding),
    finding,
  }));
  const temperature = temperatureWellbeingLevel(snapshot.sensors.temperature);
  if (temperature === "attention" || temperature === "urgent") {
    items.push({
      id: "wellbeing:temperature",
      kind: "temperature",
      level: temperature,
      intent: "heat",
      valueCelsius: snapshot.sensors.temperature.celsius!,
    });
  }
  const battery = batteryWellbeingLevel(snapshot.sensors.battery);
  if (battery === "attention" || battery === "urgent") {
    items.push({
      id: "wellbeing:battery",
      kind: "battery",
      level: battery,
      intent: "heat",
      chargePercent: snapshot.sensors.battery.chargePercent!,
    });
  }
  const sleepBlocker = summarizeSleepBlockers(
    snapshot.sensors.sleep,
    diagnosis.applications,
  ).find(({ durationSeconds, systemComponent }) =>
    !systemComponent &&
    durationSeconds !== null &&
    durationSeconds >= DAILY_SLEEP_BLOCKER_MIN_DURATION_SECONDS);
  if (sleepBlocker) {
    items.push({
      id: "wellbeing:sleep",
      kind: "sleep",
      level: "attention",
      intent: "heat",
      name: sleepBlocker.name,
      durationSeconds: sleepBlocker.durationSeconds!,
    });
  }

  return items
    .sort((left, right) => levelRank(right.level) - levelRank(left.level))
    .slice(0, Number.isFinite(limit) ? Math.max(0, limit) : undefined);
}

export function primaryDailyVolume(snapshot: SystemHealthSnapshot): VolumeUsage | null {
  const candidates = snapshot.disk.volumes
    .filter(({ totalBytes }) => totalBytes >= 4 * GIBIBYTE)
    .map(volumeUsage)
    .sort((left, right) => {
      const removableDifference = Number(left.volume.removable) - Number(right.volume.removable);
      return removableDifference ||
        right.volume.totalBytes - left.volume.totalBytes ||
        left.volume.mountPoint.localeCompare(right.volume.mountPoint);
    });
  return candidates[0] ?? null;
}

export function cleanupReclaimableBytes(scan: CleanupScan | null): number {
  if (!scan) return 0;
  return scan.locations.reduce(
    (total, location) =>
      location.available && location.safety === "reclaimable"
        ? total + Math.max(0, location.sizeBytes)
        : total,
    0,
  );
}

export function dailyApplicationSummary(
  application: ApplicationImpact,
  totalMemoryBytes: number,
): DailyApplicationSummary {
  return {
    impact: applicationImpactLevel(application, totalMemoryBytes),
    primaryResource: applicationPrimaryResource(application, totalMemoryBytes),
  };
}

export function firstUserSleepBlocker(
  diagnosis: SmartDiagnosisResult,
  sensors: SensorsSnapshot,
) {
  const blocker = summarizeSleepBlockers(sensors.sleep, diagnosis.applications)
    .find(({ systemComponent }) => !systemComponent) ?? null;
  if (!blocker) return null;
  const application = diagnosis.applications.find(
    ({ name }) => name.toLocaleLowerCase() === blocker.name.toLocaleLowerCase(),
  ) ?? null;
  return { blocker, application };
}

export function intentForFinding(finding: DiagnosisFinding): DailyIntent {
  if (finding.category === "storage") return "space";
  if (finding.category === "network") return "network";
  return "slow";
}

function strongestFinding(findings: readonly DiagnosisFinding[]) {
  return [...findings].sort(
    (left, right) => levelRank(right.severity) - levelRank(left.severity),
  )[0] ?? null;
}

function wellbeingToDailyLevel(
  level: ReturnType<typeof temperatureWellbeingLevel>,
): DailyOrbitLevel {
  return level;
}

function levelRank(level: DailyLevel): number {
  switch (level) {
    case "urgent":
      return 3;
    case "attention":
      return 2;
    case "observing":
      return 1;
    case "normal":
      return 0;
  }
}
