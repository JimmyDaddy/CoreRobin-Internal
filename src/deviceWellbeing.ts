import type { ApplicationImpact } from "./diagnosis";
import type {
  BatterySnapshot,
  SleepBlockerKind,
  SleepSnapshot,
  TemperatureSnapshot,
} from "./types";

export type DeviceWellbeingLevel = "normal" | "attention" | "urgent" | "unavailable";

export interface SleepBlockerSummary {
  name: string;
  systemComponent: boolean;
  durationSeconds: number | null;
  kinds: SleepBlockerKind[];
}

export function temperatureWellbeingLevel(
  temperature: TemperatureSnapshot,
): DeviceWellbeingLevel {
  if (temperature.celsius === null || !Number.isFinite(temperature.celsius)) {
    return "unavailable";
  }
  const urgentAt = temperature.criticalCelsius === null
    ? 90
    : Math.min(90, Math.max(80, temperature.criticalCelsius - 10));
  if (temperature.celsius >= urgentAt) return "urgent";
  if (temperature.celsius >= 75) return "attention";
  return "normal";
}

export function batteryWellbeingLevel(
  battery: BatterySnapshot,
): DeviceWellbeingLevel {
  if (!battery.present || battery.chargePercent === null) return "unavailable";
  if (battery.state !== "discharging") return "normal";
  if (battery.chargePercent <= 10) return "urgent";
  if (battery.chargePercent <= 20) return "attention";
  return "normal";
}

export function summarizeSleepBlockers(
  sleep: SleepSnapshot,
  applications: readonly ApplicationImpact[],
): SleepBlockerSummary[] {
  const grouped = new Map<string, SleepBlockerSummary>();
  for (const blocker of sleep.blockers) {
    const application = blocker.pid === null
      ? null
      : applications.find(({ memberIdentities }) =>
          memberIdentities.some((identity) => identity.startsWith(`${blocker.pid}:`))) ?? null;
    const name = application?.name ?? blocker.processName;
    const key = name.trim().toLocaleLowerCase();
    if (!key) continue;
    const existing = grouped.get(key);
    const systemComponent = application?.systemComponent ?? isKnownSystemSleepBlocker(name);
    if (existing) {
      existing.systemComponent = existing.systemComponent && systemComponent;
      existing.durationSeconds = maximumDuration(
        existing.durationSeconds,
        blocker.durationSeconds,
      );
      if (!existing.kinds.includes(blocker.kind)) existing.kinds.push(blocker.kind);
    } else {
      grouped.set(key, {
        name,
        systemComponent,
        durationSeconds: blocker.durationSeconds,
        kinds: [blocker.kind],
      });
    }
  }
  return [...grouped.values()].sort(
    (left, right) =>
      Number(left.systemComponent) - Number(right.systemComponent) ||
      (right.durationSeconds ?? -1) - (left.durationSeconds ?? -1) ||
      left.name.localeCompare(right.name),
  );
}

export function sleepWellbeingLevel(
  sleep: SleepSnapshot,
  applications: readonly ApplicationImpact[],
): DeviceWellbeingLevel {
  if (!sleep.available) return "unavailable";
  return summarizeSleepBlockers(sleep, applications).some(({ systemComponent }) =>
    !systemComponent)
    ? "attention"
    : "normal";
}

function maximumDuration(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function isKnownSystemSleepBlocker(name: string): boolean {
  return /^(?:powerd|coreaudiod|mds|mdworker|backupd|sharingd|bluetoothd|kernel_task|windowserver)$/i.test(
    name.trim(),
  );
}
