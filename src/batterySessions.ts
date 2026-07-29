import type { HistoryPoint } from "./types";

export interface BatteryUsageSession {
  id: string;
  startedAtMs: number;
  endedAtMs: number;
  ongoing: boolean;
  startChargePercent: number | null;
  endChargePercent: number | null;
  drainPercent: number | null;
  drainPercentPerHour: number | null;
  blockerNames: string[];
  majorApplicationNames: string[];
}

const SESSION_GAP_MS = 30 * 60 * 1_000;

export function buildBatteryUsageSessions(
  points: readonly HistoryPoint[],
  now = Date.now(),
): BatteryUsageSession[] {
  const ordered = [...points].sort((left, right) => left.timestamp - right.timestamp);
  const groups: HistoryPoint[][] = [];
  let current: HistoryPoint[] = [];
  for (const point of ordered) {
    const previous = current[current.length - 1];
    const onBattery = point.batteryPowerSource === "battery";
    if (
      !onBattery
      || (
        previous
        && point.timestamp - previous.timestamp > SESSION_GAP_MS
      )
    ) {
      if (current.length > 0) groups.push(current);
      current = [];
    }
    if (onBattery) current.push(point);
  }
  if (current.length > 0) groups.push(current);

  return groups
    .filter((group) => group.length >= 2)
    .map((group) => {
      const first = group[0]!;
      const last = group[group.length - 1]!;
      const startCharge = first.batteryChargePercent ?? null;
      const endCharge = last.batteryChargePercent ?? null;
      const elapsedHours = Math.max(
        0,
        (last.timestamp - first.timestamp) / (60 * 60 * 1_000),
      );
      const drainPercent =
        startCharge !== null && endCharge !== null
          ? Math.max(0, startCharge - endCharge)
          : null;
      return {
        id: `battery-${first.timestamp}`,
        startedAtMs: first.timestamp,
        endedAtMs: last.timestamp,
        ongoing: now - last.timestamp <= SESSION_GAP_MS,
        startChargePercent: startCharge,
        endChargePercent: endCharge,
        drainPercent,
        drainPercentPerHour:
          drainPercent !== null && elapsedHours > 0
            ? drainPercent / elapsedHours
            : null,
        blockerNames: mostFrequent(
          group.flatMap((point) => point.sleepBlockerNames ?? []),
          5,
        ),
        majorApplicationNames: mostFrequent(
          group
            .map((point) => point.topApplicationName)
            .filter((name): name is string => Boolean(name)),
          3,
        ),
      };
    })
    .sort((left, right) => right.startedAtMs - left.startedAtMs);
}

function mostFrequent(values: readonly string[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value]) => value);
}
