import type {
  ApplicationImpactHistoryPoint,
} from "./applicationImpactHistory";
import type { NetworkQualityHistoryPoint } from "./networkQualityHistory";
import type { ResourceAlertEvent } from "./resourceAlerts";
import type { HistoryPoint } from "./types";
import type { UserActionRecord } from "./userActionHistory";

export const HISTORY_EXPORT_METRICS = [
  "cpu",
  "memory",
  "disk",
  "network",
  "events",
  "actions",
  "applications",
] as const;

export type HistoryExportMetric = (typeof HISTORY_EXPORT_METRICS)[number];
export type HistoryExportRange = 24 | 168 | "all";
export type HistoryExportFormat = "json" | "csv";

export interface HistoryExportSelection {
  range: HistoryExportRange;
  metrics: readonly HistoryExportMetric[];
  includeApplicationNames: boolean;
}

export interface HistoryExportSources {
  points: readonly HistoryPoint[];
  alerts: readonly ResourceAlertEvent[];
  networkQualityPoints: readonly NetworkQualityHistoryPoint[];
  actions: readonly UserActionRecord[];
  applicationImpactPoints: readonly ApplicationImpactHistoryPoint[];
}

interface ExportRow {
  timestamp: number;
  category: string;
  metric: string;
  value: string | number | boolean | null;
  detail: string | null;
}

export interface HistoryExportPreview {
  fromMs: number | null;
  toMs: number;
  recordCount: number;
  fields: string[];
  includesApplicationNames: boolean;
  excludes: string[];
}

export function previewHistoryExport(
  sources: HistoryExportSources,
  selection: HistoryExportSelection,
  now = Date.now(),
): HistoryExportPreview {
  const rows = exportRows(sources, selection, now);
  return {
    fromMs: selection.range === "all"
      ? minimumTimestamp(rows)
      : now - selection.range * 60 * 60 * 1_000,
    toMs: now,
    recordCount: rows.length,
    fields: ["timestamp", "category", "metric", "value", "detail"],
    includesApplicationNames: selection.includeApplicationNames,
    excludes: ["process command lines", "full file paths", "connection addresses"],
  };
}

export function buildHistoryExport(
  sources: HistoryExportSources,
  selection: HistoryExportSelection,
  format: HistoryExportFormat,
  now = Date.now(),
): string {
  const rows = exportRows(sources, selection, now);
  if (format === "csv") return rowsToCsv(rows);
  return JSON.stringify({
    schemaVersion: 1,
    product: "CoreRobin",
    generatedAt: new Date(now).toISOString(),
    range: selection.range,
    metrics: selection.metrics,
    privacy: {
      localExport: true,
      applicationNamesIncluded: selection.includeApplicationNames,
      excluded: ["process command lines", "full file paths", "connection addresses"],
    },
    records: rows.map((row) => ({
      ...row,
      timestamp: new Date(row.timestamp).toISOString(),
    })),
  }, null, 2);
}

export function historyExportFileName(
  format: HistoryExportFormat,
  now = Date.now(),
): string {
  const date = new Date(now);
  const stamp = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return `CoreRobin-history-${stamp}.${format}`;
}

function exportRows(
  sources: HistoryExportSources,
  selection: HistoryExportSelection,
  now: number,
): ExportRow[] {
  const selected = new Set(selection.metrics);
  const cutoff = selection.range === "all"
    ? Number.NEGATIVE_INFINITY
    : now - selection.range * 60 * 60 * 1_000;
  const inRange = (timestamp: number) => timestamp >= cutoff && timestamp <= now;
  const rows: ExportRow[] = [];

  for (const point of sources.points) {
    if (!inRange(point.timestamp)) continue;
    if (selected.has("cpu")) {
      rows.push(row(point.timestamp, "resource", "cpu_percent", point.cpuPercent));
    }
    if (selected.has("memory")) {
      rows.push(row(point.timestamp, "resource", "memory_percent", point.memoryPercent));
    }
    if (selected.has("disk")) {
      rows.push(
        row(point.timestamp, "resource", "disk_read_bytes_per_second", point.diskReadBytesPerSecond),
        row(point.timestamp, "resource", "disk_write_bytes_per_second", point.diskWriteBytesPerSecond),
      );
    }
    if (selected.has("network")) {
      rows.push(
        row(point.timestamp, "resource", "network_received_bytes_per_second", point.networkReceivedBytesPerSecond),
        row(point.timestamp, "resource", "network_transmitted_bytes_per_second", point.networkTransmittedBytesPerSecond),
      );
    }
  }

  if (selected.has("network")) {
    for (const point of sources.networkQualityPoints) {
      if (!inRange(point.sampledAtMs)) continue;
      rows.push(
        row(point.sampledAtMs, "network_quality", "latency_ms", point.averageLatencyMs, point.status),
        row(point.sampledAtMs, "network_quality", "jitter_ms", point.jitterMs, point.status),
        row(
          point.sampledAtMs,
          "network_quality",
          "successful_probes",
          point.successfulProbeCount,
          `${point.probeCount} total`,
        ),
      );
    }
  }

  if (selected.has("events")) {
    for (const event of sources.alerts) {
      if (!inRange(event.timestamp)) continue;
      rows.push(row(
        event.timestamp,
        "event",
        `${event.resource}_${event.kind}`,
        event.valuePercent,
        `${event.severity}; threshold=${event.thresholdPercent}`,
      ));
    }
  }

  if (selected.has("actions")) {
    for (const action of sources.actions) {
      if (!inRange(action.startedAtMs)) continue;
      rows.push(row(
        action.startedAtMs,
        "action",
        action.kind,
        action.status,
        [
          `verification=${action.verification}`,
          action.targetCount === null ? null : `count=${action.targetCount}`,
          action.affectedBytes === null ? null : `bytes=${action.affectedBytes}`,
          selection.includeApplicationNames && action.targetName
            ? `target=${action.targetName}`
            : null,
        ].filter(Boolean).join("; "),
      ));
    }
  }

  if (selected.has("applications")) {
    const anonymousIds = new Map<string, string>();
    const displayIdentity = (applicationId: string, name: string) => {
      if (selection.includeApplicationNames) return name;
      const identity = `${applicationId}\u0000${name}`;
      const existing = anonymousIds.get(identity);
      if (existing) return existing;
      const anonymous = `application-${anonymousIds.size + 1}`;
      anonymousIds.set(identity, anonymous);
      return anonymous;
    };
    for (const point of sources.applicationImpactPoints) {
      if (!inRange(point.sampledAtMs)) continue;
      for (const application of point.applications) {
        const identity = displayIdentity(application.applicationId, application.name);
        rows.push(
          row(point.sampledAtMs, "application", "average_cpu_percent", application.averageCpuPercent, identity),
          row(point.sampledAtMs, "application", "average_memory_bytes", application.averageMemoryBytes, identity),
          row(point.sampledAtMs, "application", "average_disk_bytes_per_second", application.averageDiskBytesPerSecond, identity),
        );
      }
    }
  }

  return rows.sort((left, right) => left.timestamp - right.timestamp);
}

function row(
  timestamp: number,
  category: string,
  metric: string,
  value: ExportRow["value"],
  detail: string | null = null,
): ExportRow {
  return { timestamp, category, metric, value, detail };
}

function minimumTimestamp(rows: readonly ExportRow[]): number | null {
  return rows.length === 0
    ? null
    : Math.min(...rows.map(({ timestamp }) => timestamp));
}

function rowsToCsv(rows: readonly ExportRow[]): string {
  const header = ["timestamp", "category", "metric", "value", "detail"];
  return [
    header.join(","),
    ...rows.map((row) => [
      new Date(row.timestamp).toISOString(),
      row.category,
      row.metric,
      row.value,
      row.detail,
    ].map(csvCell).join(",")),
  ].join("\n");
}

function csvCell(value: unknown): string {
  const string = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(string)
    ? `"${string.replace(/"/g, "\"\"")}"`
    : string;
}
