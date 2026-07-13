import type {
  CommandError,
  ProcessRow,
  ProcessSortKey,
  SortDirection,
} from "./types";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number, maximumFractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toLocaleString(undefined, { maximumFractionDigits })} ${BYTE_UNITS[exponent]}`;
}

export function formatRate(bytesPerSecond: number | null): string {
  return bytesPerSecond === null ? "预热中" : `${formatBytes(bytesPerSecond)}/s`;
}

export function formatPercent(value: number | null): string {
  return value === null ? "预热中" : `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

export function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${Math.max(0, Math.floor(totalSeconds))} 秒`;
  }
  if (totalSeconds < 3_600) {
    return `${Math.floor(totalSeconds / 60)} 分钟`;
  }
  if (totalSeconds < 86_400) {
    return `${Math.floor(totalSeconds / 3_600)} 小时`;
  }
  return `${Math.floor(totalSeconds / 86_400)} 天`;
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

export function processIdentity(process: Pick<ProcessRow, "pid" | "startTime">): string {
  return `${process.pid}:${process.startTime}`;
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
    message: typeof error === "string" ? error : "发生了未知错误。",
  };
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    Run: "运行",
    Sleep: "休眠",
    Idle: "空闲",
    Stop: "停止",
    Zombie: "僵尸",
    Dead: "退出",
    LockBlocked: "锁等待",
    UninterruptibleDiskSleep: "I/O 等待",
  };
  return labels[status] ?? status;
}
