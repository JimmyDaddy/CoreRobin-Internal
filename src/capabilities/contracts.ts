import type { NetworkQualityDiagnostic } from "../types";
import { isCapabilityFormId, type CapabilityFormId } from "./formCatalog";
import type { QuickCleanCategorySummary } from "../types";

export type CapabilityAction = "refresh" | "request_close" | "force_kill" | "trash";
export interface CapabilityActionIntent { action: CapabilityAction; targetRefs: string[] }
export interface CapabilitySource { sessionId: string; messageId: string; stepId: string }
export interface CapabilityActionInput extends CapabilitySource, CapabilityActionIntent {
  expectedSessionRevision: number; submissionId: string;
}
export interface ProcessCapabilityItem {
  targetRef: string | null; name: string; pid: number; cpuPercent: number | null; memoryBytes: number; protected: boolean;
}
export interface DiskCapabilityItem {
  targetRef: string; name: string; allocatedBytes: number; logicalBytes: number; itemCount: number; safety: "reclaimable" | "review";
}
export type CapabilityResult =
  | { kind: "form"; capabilityId: CapabilityFormId; analysis?: QuickCleanCategorySummary[]; utilityOutput?: string; outputTruncated?: boolean }
  | { kind: "device"; sampledAt: number; cpuPercent: number | null; memoryUsed: number; memoryTotal: number; memoryAvailable: number; temperature: number | null; volumes: { name: string; totalBytes: number; availableBytes: number }[] }
  | { kind: "processes"; sampledAt: number; items: ProcessCapabilityItem[] }
  | { kind: "disk"; sampledAt: number; scanId: string | null; sourceRevision: number | null; scannedEntries: number; unreadableEntries: number; items: DiskCapabilityItem[] }
  | { kind: "network"; sampledAt: number; diagnostics: NetworkQualityDiagnostic[]; averageLatencyMs: number | null; tcpProbeFailurePercent: number | null }
  | { kind: "observations"; sampledAt: number; observations: { label: string; value: string }[]; coverage: string[] }
  | { kind: "cleanup"; deleted: { name: string; deletedBytes: number }[]; failed: { name: string }[]; cancelled: boolean; indexUpdated: boolean }
  | { kind: "process_action"; signalSent: boolean; outcome: "exited" | "still_running" | "already_exited" };

// Receipts come only from native execution, never from assistant prose. A
// malformed or older receipt is readable as technical details but cannot mint actions.
export function readCapabilityResult(name: string, raw: string): CapabilityResult | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (!record(data)) return null;
    if ((name === "open_application_capability" || name === "analyze_quick_cleanup" || name === "run_local_utility") && data.kind === "application_capability" && isCapabilityFormId(data.capabilityId)) {
      const categories = record(data.analysis) && Array.isArray(data.analysis.categories) ? data.analysis.categories : [];
      const analysis = categories.filter(record).flatMap((item): QuickCleanCategorySummary[] => typeof item.category === "string" && ["user_cache", "logs", "temp_files", "trash"].includes(item.category) && number(item.byteSize) !== null && number(item.itemCount) !== null && number(item.skippedCount) !== null && typeof item.available === "boolean" ? [{ category: item.category as QuickCleanCategorySummary["category"], byteSize: item.byteSize as number, itemCount: item.itemCount as number, skippedCount: item.skippedCount as number, available: item.available }] : []);
      return { kind: "form", capabilityId: data.capabilityId, ...(name === "run_local_utility" && data.operationExecuted === true && typeof data.utilityOutput === "string" ? { utilityOutput: data.utilityOutput, outputTruncated: data.outputTruncated === true } : {}), ...(analysis.length > 0 ? { analysis: analysis.slice(0, 4) } : {}) };
    }
    const sampledAt = number(data.sampledAt ?? data.sampledAtMs) ?? 0;
    if (name === "scan_disk_usage" && Array.isArray(data.items)) {
      const items = data.items.filter(record).flatMap((item): DiskCapabilityItem[] =>
        typeof item.targetRef === "string" && typeof item.name === "string" && number(item.allocatedBytes) !== null && number(item.logicalBytes) !== null && number(item.itemCount) !== null && (item.safety === "review" || item.safety === "reclaimable")
          ? [{ targetRef: item.targetRef, name: item.name, allocatedBytes: item.allocatedBytes as number, logicalBytes: item.logicalBytes as number, itemCount: item.itemCount as number, safety: item.safety }] : []);
      return { kind: "disk", sampledAt, scanId: typeof data.scanId === "string" ? data.scanId : null, sourceRevision: number(data.sourceRevision), scannedEntries: number(data.scannedEntries) ?? 0, unreadableEntries: number(data.unreadableEntries) ?? 0, items: items.slice(0, 12) };
    }
    if (name === "get_process_usage" && Array.isArray(data.processes)) {
      const items = data.processes.filter(record).flatMap((item): ProcessCapabilityItem[] => typeof item.name === "string" && number(item.pid) !== null && number(item.memoryBytes) !== null
        ? [{ targetRef: typeof item.targetRef === "string" ? item.targetRef : null, name: item.name, pid: item.pid as number, cpuPercent: number(item.cpuPercent), memoryBytes: item.memoryBytes as number, protected: item.protected !== false }] : []);
      return { kind: "processes", sampledAt, items: items.slice(0, 10) };
    }
    if (name === "get_device_status" && record(data.cpu) && record(data.memory)) {
      if (number(data.memory.usedBytes) === null || number(data.memory.totalBytes) === null || number(data.memory.availableBytes) === null) return null;
      const disk = record(data.disk) ? data.disk : {};
      const volumes = Array.isArray(disk.volumes) ? disk.volumes.filter(record).flatMap((volume) => typeof volume.name === "string" && number(volume.totalBytes) !== null && number(volume.availableBytes) !== null ? [{ name: volume.name, totalBytes: volume.totalBytes as number, availableBytes: volume.availableBytes as number }] : []) : [];
      return { kind: "device", sampledAt, cpuPercent: number(data.cpu.usagePercent), memoryUsed: number(data.memory.usedBytes) ?? 0, memoryTotal: number(data.memory.totalBytes) ?? 0, memoryAvailable: number(data.memory.availableBytes) ?? 0, temperature: number(data.temperatureCelsius), volumes };
    }
    if (name === "run_network_check" && Array.isArray(data.diagnostics)) {
      const kinds = ["local_link", "dns", "ipv4", "ipv6", "internet", "independent_service"];
      const statuses = ["passed", "degraded", "failed", "unavailable"];
      const diagnostics = data.diagnostics.filter(record).flatMap((item): NetworkQualityDiagnostic[] => typeof item.kind === "string" && kinds.includes(item.kind) && typeof item.status === "string" && statuses.includes(item.status) ? [{ kind: item.kind as NetworkQualityDiagnostic["kind"], status: item.status as NetworkQualityDiagnostic["status"], latencyMs: number(item.latencyMs) }] : []);
      return { kind: "network", sampledAt, diagnostics, averageLatencyMs: number(data.averageLatencyMs), tcpProbeFailurePercent: number(data.tcpProbeFailurePercent) };
    }
    if (Array.isArray(data.observations)) return { kind: "observations", sampledAt, observations: data.observations.filter(record).flatMap((item) => typeof item.label === "string" && (typeof item.value === "string" || typeof item.value === "number") ? [{ label: item.label, value: `${item.value}${typeof item.unit === "string" ? ` ${item.unit}` : ""}` }] : []), coverage: Array.isArray(data.coverage) ? data.coverage.filter((value): value is string => typeof value === "string") : [] };
    if (name === "request_cleanup" && Array.isArray(data.deleted) && Array.isArray(data.failed)) return { kind: "cleanup", deleted: data.deleted.filter(record).flatMap((item) => typeof item.name === "string" ? [{ name: item.name, deletedBytes: number(item.deletedBytes) ?? 0 }] : []), failed: data.failed.filter(record).flatMap((item) => typeof item.name === "string" ? [{ name: item.name }] : []), cancelled: data.cancelled === true, indexUpdated: data.indexUpdated !== false };
    if (name === "request_process_action" && typeof data.signalSent === "boolean" && (data.outcome === "exited" || data.outcome === "still_running" || data.outcome === "already_exited")) return { kind: "process_action", signalSent: data.signalSent, outcome: data.outcome };
    return null;
  } catch { return null; }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null; }
