import {
  SNAPSHOT_SCHEMA_VERSION,
  type CommandError,
  type ProcessDetail,
  type ProcessKey,
  type ProcessRow,
  type ProcessSortKey,
  type SortDirection,
  type SystemSnapshot,
} from "./types";
import i18n from "./i18n";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export type ResourceUsageLevel =
  | "unavailable"
  | "low"
  | "moderate"
  | "high"
  | "critical";

export function assertSupportedSnapshotSchema(
  snapshot: Pick<SystemSnapshot, "schemaVersion">,
): void {
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      i18n.t("format.unsupportedSchema", { version: snapshot.schemaVersion }),
    );
  }
}

export function formatBytes(bytes: number, maximumFractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toLocaleString(i18n.resolvedLanguage, { maximumFractionDigits })} ${BYTE_UNITS[exponent]}`;
}

export function formatRate(bytesPerSecond: number | null): string {
  return bytesPerSecond === null
    ? i18n.t("common.warmup")
    : `${formatBytes(bytesPerSecond)}/s`;
}

export function formatPercent(value: number | null): string {
  return value === null
    ? i18n.t("common.warmup")
    : `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return i18n.t("format.seconds", {
      count: Math.max(0, Math.floor(totalSeconds)),
    });
  }
  if (totalSeconds < 3_600) {
    return i18n.t("format.minutes", {
      count: Math.floor(totalSeconds / 60),
    });
  }
  if (totalSeconds < 86_400) {
    return i18n.t("format.hours", {
      count: Math.floor(totalSeconds / 3_600),
    });
  }
  return i18n.t("format.days", {
    count: Math.floor(totalSeconds / 86_400),
  });
}

export function resourceUsageLevel(
  value: number | null,
  thresholds: readonly [number, number, number] = [35, 65, 85],
): ResourceUsageLevel {
  if (value === null || !Number.isFinite(value)) return "unavailable";
  if (value < thresholds[0]) return "low";
  if (value < thresholds[1]) return "moderate";
  if (value < thresholds[2]) return "high";
  return "critical";
}

export function memoryUsagePercent(used: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, (used / total) * 100));
}

export function processDiskRate(process: ProcessRow): number | null {
  if (
    process.diskReadBytesPerSecond === null &&
    process.diskWriteBytesPerSecond === null
  ) {
    return null;
  }

  return (
    (process.diskReadBytesPerSecond ?? 0) +
    (process.diskWriteBytesPerSecond ?? 0)
  );
}

export function sortAndFilterProcesses(
  processes: ProcessRow[],
  query: string,
  sortKey: ProcessSortKey,
  direction: SortDirection,
): ProcessRow[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = normalizedQuery
    ? processes.filter((process) => {
        const haystack = [
          process.name,
          String(process.pid),
          process.user ?? "",
          process.status,
        ]
          .join(" ")
          .toLocaleLowerCase();
        return haystack.includes(normalizedQuery);
      })
    : [...processes];

  const multiplier = direction === "ascending" ? 1 : -1;
  return filtered.sort((left, right) => {
    let comparison = 0;
    switch (sortKey) {
      case "name":
        comparison = left.name.localeCompare(right.name);
        break;
      case "memory":
        comparison = left.memoryBytes - right.memoryBytes;
        break;
      case "disk":
        comparison =
          (processDiskRate(left) ?? Number.NEGATIVE_INFINITY) -
          (processDiskRate(right) ?? Number.NEGATIVE_INFINITY);
        break;
      case "cpu":
        comparison =
          (left.cpuPercent ?? Number.NEGATIVE_INFINITY) -
          (right.cpuPercent ?? Number.NEGATIVE_INFINITY);
        break;
    }

    if (comparison === 0) {
      comparison = left.pid - right.pid;
    }
    return comparison * multiplier;
  });
}

export function processIdentity(
  process: Pick<ProcessRow, "pid" | "startTime" | "birthToken">,
): string {
  return `${process.pid}:${process.birthToken ?? `fallback:${process.startTime}`}`;
}

export function detailMatchesProcess(
  detail: Pick<ProcessDetail, "pid" | "startTime" | "key"> | null,
  process: Pick<ProcessRow, "pid" | "startTime" | "birthToken"> | null,
): boolean {
  return Boolean(
    detail &&
      process &&
      detail.pid === process.pid &&
      detail.startTime === process.startTime &&
      (detail.key?.birthToken ?? null) === process.birthToken,
  );
}

export function processKeysEqual(
  left: ProcessKey | null,
  right: ProcessKey | null,
): boolean {
  return Boolean(
    left &&
      right &&
      left.pid === right.pid &&
      left.birthToken === right.birthToken,
  );
}

export function normalizeCommandError(error: unknown): CommandError {
  if (typeof error === "object" && error !== null) {
    const candidate = error as Partial<CommandError>;
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code, message: candidate.message };
    }
  }

  if (error instanceof Error) {
    return { code: "unknown_error", message: error.message };
  }

  return {
    code: "unknown_error",
    message: typeof error === "string" ? error : i18n.t("format.unknownError"),
  };
}

export function statusLabel(status: string): string {
  const key = `process.status.${status}`;
  return i18n.exists(key) ? i18n.t(key) : status;
}
