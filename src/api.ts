import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  createMockCleanupDeleteLease,
  getMockApplicationUninstallPlan,
  getMockInstalledApplications,
  createMockProcessControlLease,
  createMockStartupManagementLease,
  executeMockCleanupDelete,
  executeMockProcessAction,
  executeMockStartupManagement,
  getMockCleanupScan,
  getMockStartupItems,
  getMockNetworkConnections,
  getMockProcessDetail,
  getMockSnapshot,
  releaseMockProcessControlLease,
  releaseMockCleanupDeleteLease,
  setMockCleanupDeleteLeaseMode,
  releaseMockStartupManagementLease,
} from "./mockData";
import type {
  ApplicationIcon,
  ApplicationIconRequest,
  ApplicationInventorySnapshot,
  ApplicationUninstallPlan,
  CleanupNode,
  CleanupIndexedChildrenPage,
  CleanupIndexedChildrenRequest,
  CleanupIndexedDirectoryRequest,
  CleanupPathState,
  CleanupScan,
  CleanupScanAccess,
  CleanupScanIndexSummary,
  CleanupScanJobStatus,
  CleanupScanTarget,
  CleanupDeleteExecutionRequest,
  CleanupDeleteLease,
  CleanupDeleteLeaseModeRequest,
  CleanupDeleteLeaseReleaseRequest,
  CleanupDeleteLeaseRequest,
  CleanupIndexDeletionRequest,
  CleanupDeleteProgress,
  CleanupDeleteResult,
  CleanupDirectoryRefreshRequest,
  ProcessActionRequest,
  ProcessActionResult,
  ProcessControlLease,
  ProcessControlLeaseReleaseRequest,
  ProcessControlLeaseRequest,
  ProcessDetail,
  ProcessDetailRequest,
  QuickCleanCategory,
  QuickCleanCategorySummary,
  QuickCleanProgress,
  QuickCleanResult,
  NetworkConnectionsSnapshot,
  NetworkHostLookup,
  NetworkQualityResult,
  NativeApplicationUninstallResult,
  TrashedApplication,
  StartupContext,
  FileInsightsProgress,
  FileInsightsScan,
  GpuEnergySnapshot,
  SystemSnapshot,
  SystemSummary,
  StorageHealthSnapshot,
  SamplerControl,
  SamplerStatus,
  StartupItemsSnapshot,
  StartupManagementExecutionRequest,
  StartupManagementLease,
  StartupManagementLeaseReleaseRequest,
  StartupManagementLeaseRequest,
  StartupManagementResult,
  SystemSettingsDestination,
} from "./types";
import { productPageUrl, type ProductPage } from "./productSupport";
import { DEFAULT_LANGUAGE, normalizeLanguage, type SupportedLanguage } from "./language";
export type { ProductPage } from "./productSupport";
import type {
  KeyboardCleaningHeartbeatCommand,
  KeyboardCleaningSignal,
  KeyboardCleaningStartCommand,
  KeyboardCleaningStopCommand,
} from "./toolbox/system/keyboard-cleaning/keyboardCleaning";

export interface ToolboxFileHashProgress {
  requestId: string;
  bytesRead: number;
  totalBytes: number;
  phase: "hashing" | "completed";
}

export interface ToolboxFileHashResult {
  requestId: string;
  pathHint: string;
  bytesRead: number;
  digest: string;
  generation: number | null;
  resetEpoch: number | null;
}

export interface ToolboxPowerState {
  status: "inactive" | "active" | "cancelled";
  requestId: string | null;
  expiresAtMs: number | null;
  platform: string;
  reason: string | null;
}

export type ToolboxScheduleAction =
  | { kind: "reminder" }
  | { kind: "keepAwake"; durationMinutes: number };

export type ToolboxScheduleTrigger =
  | { kind: "once"; atMs: number }
  | { kind: "daily"; hour: number; minute: number; nextRunAtMs: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number; nextRunAtMs: number }
  | { kind: "cron"; expression: string; nextRunAtMs: number };

export interface ToolboxScheduleRule {
  scheduleId: string;
  timeZone: string;
  title: string | null;
  action: ToolboxScheduleAction;
  trigger: ToolboxScheduleTrigger;
  status: "scheduled" | "paused";
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ToolboxScheduleSnapshot {
  revision: number;
  maxRules: number;
  persistent: boolean;
  restartNotice: string;
  executionNotice: string;
  rules: ToolboxScheduleRule[];
}

export type ToolboxSchedulePreviewTrigger =
  | { kind: "once"; atUtcMs: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "cron"; expression: string };

export interface ToolboxSchedulePreviewRequest {
  timeZone: string;
  trigger: ToolboxSchedulePreviewTrigger;
}

export interface ToolboxSchedulePreview {
  timeZone: string;
  status: "ready" | "noOccurrenceInHorizon";
  occurrenceAtMs: number[];
  horizonEndAtMs: number;
  truncated: boolean;
}

export interface ToolboxPolicy {
  schemaVersion: number;
  policyRevision: number;
  globalHistoryEnabled: boolean;
  toolboxHistoryEnabled: boolean;
  retentionDays: number;
  notificationsEnabled: boolean;
  language: string;
}

export interface ToolboxStorageSnapshot {
  policy: ToolboxPolicy;
  resetEpoch: number;
  historyRevision: number;
  activeActivityIds: string[];
}

export interface ToolboxHistoryRecord {
  recordId: string;
  tool: "keep-awake" | "process-watch" | "file-occupancy" | "volume-occupancy" | "keyboard-cleaning" | "network-addresses" | "ifconfig-parser";
  startedAtMs: number;
  completedAtMs: number;
  terminalStatus: "completed" | "cancelled" | "expired" | "failed" | "interrupted" | "deadline" | "process_exited" | "low_battery" | "release_unconfirmed";
  notificationStatus: "submitted" | "failed" | "unavailable";
}

export interface ToolboxHistoryPage {
  records: ToolboxHistoryRecord[];
  nextCursor: string | null;
  historyRevision: number;
}

export interface ToolboxProcessWatchKey {
  pid: number;
  birthToken: string;
}

export type ToolboxProcessWatchStatus = "running" | "exited" | "unknown" | "identity_changed" | "expired" | "cancelled";

export interface ToolboxProcessWatchSnapshot {
  watchId: number;
  key: ToolboxProcessWatchKey;
  status: ToolboxProcessWatchStatus;
  startedAtMs: number;
  deadlineAtMs: number;
  lastCheckedAtMs: number;
}

export interface ToolboxOccupancyProcess {
  pid: number;
  command: string | null;
  user: string | null;
  evidenceTypes: string[];
}

export interface ToolboxOccupancyResult {
  requestId: string;
  status: "scoped_complete" | "truncated" | "timed_out" | "target_changed" | "unsupported";
  pathHint: string;
  capturedAtMs: number;
  processes: ToolboxOccupancyProcess[];
  coverage: string[];
  truncated: boolean;
  message: string | null;
}

export const KEYBOARD_CLEANING_EVENT = "core-robin:keyboard-cleaning";

export function startKeyboardCleaning(request: KeyboardCleaningStartCommand): Promise<void> {
  return invoke("start_keyboard_cleaning", { request });
}

export function stopKeyboardCleaning(request: KeyboardCleaningStopCommand): Promise<void> {
  return invoke("stop_keyboard_cleaning", { request });
}

export function emergencyStopKeyboardCleaning(): Promise<void> {
  return invoke("stop_keyboard_cleaning", { request: null });
}

export function heartbeatKeyboardCleaning(request: KeyboardCleaningHeartbeatCommand): Promise<void> {
  return invoke("heartbeat_keyboard_cleaning", { request });
}

export function subscribeKeyboardCleaning(
  callback: (signal: KeyboardCleaningSignal) => void,
): Promise<UnlistenFn> {
  return listen<KeyboardCleaningSignal>(KEYBOARD_CLEANING_EVENT, (event) => callback(event.payload));
}
import type {
  HealthStateSnapshot,
  HealthStateUpdate,
} from "./healthState";
import type { BackgroundSupervisorConfig } from "./backgroundSupervisor";

let mockCleanupDeleteCancelled = false;
let mockCleanupDeleteInFlight = false;
const mockCleanupDeletePaths = new Map<string, string[]>();
const mockCleanupDeleteModes = new Map<string, CleanupDeleteLease["mode"]>();
const APPLICATION_INVENTORY_MEMORY_TTL_MS = 5 * 60 * 1_000;
const applicationInventoryMemory = new Map<SupportedLanguage, {
  receivedAtMs: number;
  snapshot: ApplicationInventorySnapshot;
}>();
const applicationInventoryInFlight = new Map<
  SupportedLanguage,
  {
    forceRefresh: boolean;
    request: Promise<ApplicationInventorySnapshot>;
  }
>();

export interface ProductDataCacheItemSummary {
  byteSize: number;
  fileCount: number;
  updatedAtMs: number | null;
}

export interface ProductDataCacheSummary {
  cleanupScan: ProductDataCacheItemSummary;
  fileInsights: ProductDataCacheItemSummary;
  applicationInventory: ProductDataCacheItemSummary;
  applicationHistory: ProductDataCacheItemSummary;
  historySegments: ProductDataCacheItemSummary;
}

export interface ApplicationHistoryStorage {
  payload: string | null;
  byteSize: number;
  updatedAtMs: number | null;
}

export type HistoryStorageCategory =
  | "resource"
  | "resource-alerts"
  | "network-quality"
  | "connections"
  | "user-actions"
  | "application-watch"
  | "startup-impact"
  | "cleanup-scans";

export interface HistorySegmentStorage {
  payload: string | null;
  byteSize: number;
  updatedAtMs: number | null;
}

export interface HistoryStorageSummary {
  byteSize: number;
  fileCount: number;
  updatedAtMs: number | null;
}

const EMPTY_PRODUCT_DATA_CACHE_ITEM: ProductDataCacheItemSummary = {
  byteSize: 0,
  fileCount: 0,
  updatedAtMs: null,
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

export async function hashToolboxFile(
  request: { requestId: string; job: import("./toolbox/contracts").ToolboxFileJobKey; token: string },
  onProgress: (progress: ToolboxFileHashProgress) => void,
): Promise<ToolboxFileHashResult> {
  const progressChannel = new Channel<ToolboxFileHashProgress>(onProgress);
  return invoke<ToolboxFileHashResult>("start_toolbox_file_hash", { request, onProgress: progressChannel });
}

export async function cancelToolboxFileHash(): Promise<boolean> {
  return invoke<boolean>("cancel_toolbox_file_hash");
}

export async function writeToolboxTextCopy(path: string, content: string): Promise<void> {
  return invoke<void>("write_toolbox_text_copy", { request: { path, content } });
}

export async function startToolboxKeepAwake(request: { requestId: string; durationMinutes: number }): Promise<ToolboxPowerState> {
  return invoke<ToolboxPowerState>("start_toolbox_keep_awake", { request });
}

export async function cancelToolboxKeepAwake(): Promise<ToolboxPowerState> {
  return invoke<ToolboxPowerState>("cancel_toolbox_keep_awake");
}

export async function getToolboxKeepAwakeState(): Promise<ToolboxPowerState> {
  return invoke<ToolboxPowerState>("get_toolbox_keep_awake_state");
}

export async function getToolboxScheduleSnapshot(): Promise<ToolboxScheduleSnapshot> {
  return invoke<ToolboxScheduleSnapshot>("get_toolbox_schedule_snapshot");
}

export function previewToolboxSchedule(request: ToolboxSchedulePreviewRequest): Promise<ToolboxSchedulePreview> {
  return invoke<ToolboxSchedulePreview>("preview_toolbox_schedule", { request });
}

export function getToolboxStorageSnapshot(): Promise<ToolboxStorageSnapshot> {
  return invoke<ToolboxStorageSnapshot>("get_toolbox_storage_snapshot");
}

export function configureToolboxPolicy(request: {
  expectedPolicyRevision: number;
  globalHistoryEnabled: boolean;
  toolboxHistoryEnabled: boolean;
  retentionDays: number;
  notificationsEnabled: boolean;
  language: string;
}): Promise<ToolboxPolicy> {
  return invoke<ToolboxPolicy>("configure_toolbox_policy", { request });
}

export function listToolboxHistory(request: { limit: number; cursor?: string | null }): Promise<ToolboxHistoryPage> {
  return invoke<ToolboxHistoryPage>("list_toolbox_history", { request });
}

export function clearToolboxHistory(expectedHistoryRevision?: number): Promise<ToolboxHistoryPage> {
  return invoke<ToolboxHistoryPage>("clear_toolbox_history", { request: { expectedHistoryRevision } });
}

export async function createToolboxSchedule(request: {
  requestId: string;
  timeZone: string;
  title?: string;
  action: ToolboxScheduleAction;
  trigger: ToolboxScheduleTrigger;
}): Promise<ToolboxScheduleSnapshot> {
  return invoke<ToolboxScheduleSnapshot>("create_toolbox_schedule", { request });
}

export async function updateToolboxSchedule(request: {
  requestId: string;
  scheduleId: string;
  expectedRevision?: number;
  timeZone: string;
  title?: string;
  action: ToolboxScheduleAction;
  trigger: ToolboxScheduleTrigger;
}): Promise<ToolboxScheduleSnapshot> {
  return invoke<ToolboxScheduleSnapshot>("update_toolbox_schedule", { request });
}

export async function pauseToolboxSchedule(request: { requestId: string; scheduleId: string; expectedRevision?: number }): Promise<ToolboxScheduleSnapshot> {
  return invoke<ToolboxScheduleSnapshot>("pause_toolbox_schedule", { request });
}

export async function resumeToolboxSchedule(request: { requestId: string; scheduleId: string; expectedRevision?: number }): Promise<ToolboxScheduleSnapshot> {
  return invoke<ToolboxScheduleSnapshot>("resume_toolbox_schedule", { request });
}

export async function deleteToolboxSchedule(request: { requestId: string; scheduleId: string; expectedRevision?: number }): Promise<ToolboxScheduleSnapshot> {
  return invoke<ToolboxScheduleSnapshot>("delete_toolbox_schedule", { request });
}

export async function startToolboxProcessWatch(request: {
  key: ToolboxProcessWatchKey;
  durationMinutes: number;
  keepAwake?: boolean;
}): Promise<ToolboxProcessWatchSnapshot> {
  return invoke<ToolboxProcessWatchSnapshot>("start_toolbox_process_watch", { request });
}

export async function getToolboxProcessWatches(): Promise<ToolboxProcessWatchSnapshot[]> {
  return invoke<ToolboxProcessWatchSnapshot[]>("get_toolbox_process_watches");
}

export async function cancelToolboxProcessWatch(request: { watchId: number }): Promise<ToolboxProcessWatchSnapshot | null> {
  return invoke<ToolboxProcessWatchSnapshot | null>("cancel_toolbox_process_watch", { request });
}

export async function scanToolboxFileOccupancy(request: { requestId: string; path: string }): Promise<ToolboxOccupancyResult> {
  return invoke<ToolboxOccupancyResult>("scan_toolbox_file_occupancy", { request });
}

export async function scanToolboxVolumeOccupancy(request: { requestId: string; path: string }): Promise<ToolboxOccupancyResult> {
  return invoke<ToolboxOccupancyResult>("scan_toolbox_volume_occupancy", { request });
}

export function cancelToolboxOccupancy(): Promise<boolean> {
  return invoke<boolean>("cancel_toolbox_occupancy");
}

export async function setDockIconVisible(visible: boolean): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke<void>("set_dock_icon_visible", { visible });
}

export async function getLaunchAtLogin(): Promise<boolean> {
  if (!isDesktopRuntime()) return false;
  return invoke<boolean>("get_launch_at_login");
}

export async function setLaunchAtLogin(enabled: boolean): Promise<void> {
  if (!isDesktopRuntime()) return;
  await invoke<void>("set_launch_at_login", { enabled });
}

export async function publishHealthState(
  update: HealthStateUpdate,
): Promise<HealthStateSnapshot> {
  return invoke<HealthStateSnapshot>("publish_health_state", { update });
}

export async function getHealthState(): Promise<HealthStateSnapshot | null> {
  return invoke<HealthStateSnapshot | null>("get_health_state");
}

function canUseDevelopmentMock(): boolean {
  return import.meta.env.DEV && !isDesktopRuntime();
}

export async function getSystemSnapshot(): Promise<SystemSnapshot> {
  if (canUseDevelopmentMock()) {
    return getMockSnapshot();
  }
  return invoke<SystemSnapshot>("get_system_snapshot");
}

export async function getSystemSummary(): Promise<SystemSummary> {
  if (canUseDevelopmentMock()) {
    const snapshot = getMockSnapshot();
    return {
      sequence: snapshot.sequence,
      sampledAtMs: snapshot.sampledAtMs,
      sampleIntervalMs: snapshot.sampleIntervalMs,
      cpu: snapshot.cpu,
      memory: snapshot.memory,
      disk: snapshot.disk,
      network: snapshot.network,
      sensors: snapshot.sensors,
    };
  }
  return invoke<SystemSummary>("get_system_summary");
}

export async function getSamplerStatus(): Promise<SamplerStatus> {
  if (canUseDevelopmentMock()) {
    return {
      running: true,
      paused: false,
      active: true,
      intervalMs: 1_000,
      fullSnapshotIntervalMs: null,
      lastFullSnapshotAtMs: Date.now(),
      lastFrontendHeartbeatAtMs: Date.now(),
      dataFreshness: "live",
      sampleKind: "full",
      lastAttemptAtMs: Date.now(),
      lastSuccessAtMs: Date.now(),
      consecutiveFailures: 0,
      degradedReason: null,
    };
  }
  return invoke<SamplerStatus>("get_sampler_status");
}

export async function setSamplerControl(
  control: SamplerControl,
): Promise<SamplerStatus> {
  if (canUseDevelopmentMock()) {
    return {
      running: true,
      paused: control.paused,
      active: control.active,
      intervalMs: control.intervalMs ?? (control.active ? 1_000 : 5_000),
      fullSnapshotIntervalMs: control.fullSnapshotIntervalMs ?? null,
      lastFullSnapshotAtMs: Date.now(),
      lastFrontendHeartbeatAtMs: Date.now(),
      dataFreshness: control.paused ? "paused" : "live",
      sampleKind: control.active ? "full" : "summary",
      lastAttemptAtMs: Date.now(),
      lastSuccessAtMs: Date.now(),
      consecutiveFailures: 0,
      degradedReason: null,
    };
  }
  return invoke<SamplerStatus>("set_sampler_control", { control });
}

export async function reportFrontendHeartbeat(): Promise<SamplerStatus> {
  if (canUseDevelopmentMock()) return getSamplerStatus();
  return invoke<SamplerStatus>("report_frontend_heartbeat");
}

export async function configureBackgroundSupervisor(
  config: BackgroundSupervisorConfig,
): Promise<void> {
  if (canUseDevelopmentMock()) return;
  await invoke<void>("configure_background_supervisor", { config });
}

export async function getNetworkConnections(): Promise<NetworkConnectionsSnapshot> {
  if (canUseDevelopmentMock()) {
    return getMockNetworkConnections();
  }
  return invoke<NetworkConnectionsSnapshot>("get_network_connections");
}

export async function runNetworkQualityCheck(): Promise<NetworkQualityResult> {
  if (canUseDevelopmentMock()) {
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    return {
      sampledAtMs: Date.now(),
      routeSignature: "mock-default-route",
      targetHost: "example.com",
      targetPort: 443,
      targetCount: 2,
      successfulTargetCount: 2,
      status: "online",
      dnsAvailable: true,
      dnsLookupMs: 18,
      resolvedAddressCount: 4,
      probeCount: 6,
      successfulProbeCount: 6,
      averageLatencyMs: 31.4,
      minimumLatencyMs: 27.8,
      maximumLatencyMs: 38.2,
      jitterMs: 3.7,
      tcpProbeFailurePercent: 0,
      diagnostics: [
        { kind: "local_link", status: "passed", latencyMs: null },
        { kind: "dns", status: "passed", latencyMs: 18 },
        { kind: "ipv4", status: "passed", latencyMs: null },
        { kind: "ipv6", status: "unavailable", latencyMs: null },
        { kind: "internet", status: "passed", latencyMs: 24.1 },
        { kind: "independent_service", status: "passed", latencyMs: 31.4 },
      ],
    };
  }
  return invoke<NetworkQualityResult>("run_network_quality_check");
}

export async function resolveNetworkHosts(
  addresses: string[],
): Promise<NetworkHostLookup[]> {
  if (canUseDevelopmentMock()) {
    return addresses.map((address, index) => ({
      address,
      hostname: index % 2 === 0 ? `host-${index + 1}.example` : null,
    }));
  }
  return invoke<NetworkHostLookup[]>("resolve_network_hosts", {
    request: { addresses },
  });
}

export async function getStartupContext(): Promise<StartupContext> {
  if (canUseDevelopmentMock()) {
    return { backgroundLaunch: false, launchedAtMs: Date.now() };
  }
  return invoke<StartupContext>("get_startup_context");
}

export async function getGpuEnergySnapshot(): Promise<GpuEnergySnapshot> {
  if (canUseDevelopmentMock()) {
    const snapshot = getMockSnapshot();
    return {
      sampledAtMs: Date.now(),
      gpuAvailable: true,
      processEnergyAvailable: true,
      adapters: [{
        name: "Apple GPU",
        utilizationPercent: 18,
        memoryUsedBytes: 1_420_000_000,
        memoryTotalBytes: null,
        coreCount: 14,
      }],
      processEnergy: snapshot.processes.slice(0, 6).map((process, index) => ({
        pid: process.pid,
        impact: Math.max(0, 18 - index * 2.7),
      })),
    };
  }
  return invoke<GpuEnergySnapshot>("get_gpu_energy_snapshot");
}

export async function scanFileInsights(
  onProgress: (progress: FileInsightsProgress) => void,
): Promise<FileInsightsScan> {
  if (canUseDevelopmentMock()) {
    onProgress({
      phase: "discovering",
      scannedEntryCount: 2_480,
      candidateFileCount: 136,
      hashedFileCount: 0,
      currentPath: "~/Downloads",
    });
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    onProgress({
      phase: "hashing",
      scannedEntryCount: 8_920,
      candidateFileCount: 412,
      hashedFileCount: 48,
      currentPath: "~/Documents/archive.zip",
    });
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    return {
      sampledAtMs: Date.now(),
      durationMs: 1_240,
      scannedEntryCount: 8_920,
      candidateFileCount: 412,
      hashedFileCount: 78,
      duplicateGroups: [{
        digest: "demo",
        sizeBytes: 284_000_000,
        reclaimableBytes: 284_000_000,
        files: [
          { name: "archive.zip", path: "/Users/demo/Downloads/archive.zip", sizeBytes: 284_000_000, logicalSizeBytes: 284_000_000, allocatedSizeBytes: 284_000_000, modifiedAtMs: Date.now() - 20_000_000 },
          { name: "archive copy.zip", path: "/Users/demo/Documents/archive copy.zip", sizeBytes: 284_000_000, logicalSizeBytes: 284_000_000, allocatedSizeBytes: 284_000_000, modifiedAtMs: Date.now() - 18_000_000 },
        ],
      }],
      longUnmodifiedFiles: [{
        name: "old-video.mov",
        path: "/Users/demo/Movies/old-video.mov",
        sizeBytes: 1_800_000_000,
        logicalSizeBytes: 1_800_000_000,
        allocatedSizeBytes: 1_800_000_000,
        modifiedAtMs: Date.now() - 250 * 86_400_000,
      }],
      unreadableEntryCount: 0,
      truncated: false,
    };
  }
  const progressChannel = new Channel<FileInsightsProgress>(onProgress);
  return invoke<FileInsightsScan>("scan_file_insights", { onProgress: progressChannel });
}

export async function cancelFileInsightsScan(): Promise<void> {
  if (canUseDevelopmentMock()) return;
  return invoke<void>("cancel_file_insights_scan");
}

export async function revalidateFileInsightsScan(
  snapshot: FileInsightsScan,
): Promise<FileInsightsScan> {
  if (canUseDevelopmentMock()) return snapshot;
  return invoke<FileInsightsScan>("revalidate_file_insights_scan", { snapshot });
}

export async function getStartupItems(): Promise<StartupItemsSnapshot> {
  if (canUseDevelopmentMock()) return getMockStartupItems();
  return invoke<StartupItemsSnapshot>("get_startup_items");
}

export async function createStartupManagementLease(
  request: StartupManagementLeaseRequest,
): Promise<StartupManagementLease> {
  if (canUseDevelopmentMock()) return createMockStartupManagementLease(request);
  return invoke<StartupManagementLease>("create_startup_management_lease", { request });
}

export async function releaseStartupManagementLease(
  request: StartupManagementLeaseReleaseRequest,
): Promise<void> {
  if (canUseDevelopmentMock()) {
    releaseMockStartupManagementLease(request);
    return;
  }
  return invoke<void>("release_startup_management_lease", { request });
}

export async function executeStartupManagement(
  request: StartupManagementExecutionRequest,
): Promise<StartupManagementResult> {
  if (canUseDevelopmentMock()) return executeMockStartupManagement(request);
  return invoke<StartupManagementResult>("execute_startup_management", { request });
}

export async function startCleanupScan(
  target: CleanupScanTarget = {
    profile: "common_locations",
    targetKind: "system_disk",
    targetPath: null,
  },
): Promise<CleanupScanJobStatus> {
  if (canUseDevelopmentMock()) {
    const now = Date.now();
    return {
      jobId: `mock-cleanup-${now}`,
      generation: now,
      phase: "completed",
      startedAtMs: now - 1_480,
      updatedAtMs: now,
      lastHeartbeatAtMs: now,
      lastProgressAtMs: now,
      progress: {
        scannedEntryCount: 21_104,
        discoveredBytes: 17_430_000_000,
        currentPath: "~/.config",
        elapsedMs: 1_480,
      },
      target,
      resultAvailable: true,
      errorCode: null,
      errorMessage: null,
    };
  }
  return invoke<CleanupScanJobStatus>("start_cleanup_scan", {
    request: target,
  });
}

export async function getCleanupScanJob(): Promise<CleanupScanJobStatus | null> {
  if (canUseDevelopmentMock()) return null;
  return invoke<CleanupScanJobStatus | null>("get_cleanup_scan_job");
}

export async function loadCleanupScanJobResult(jobId: string): Promise<CleanupScan> {
  if (canUseDevelopmentMock()) return getMockCleanupScan();
  return invoke<CleanupScan>("load_cleanup_scan_job_result", { jobId });
}

export async function getCleanupScanAccess(): Promise<CleanupScanAccess> {
  if (canUseDevelopmentMock()) {
    const demo = new URLSearchParams(window.location.search).get("demo");
    if (demo === "cleanup-access" || demo === "cleanup-access-dev") {
      return {
        fullDiskAccess: "not_granted",
        fullDiskAccessRecommended: true,
        applicationBundleAvailable: demo === "cleanup-access",
        applicationBundlePath: demo === "cleanup-access" ? "/Applications/CoreRobin.app" : null,
      };
    }
    return {
      fullDiskAccess: "not_required",
      fullDiskAccessRecommended: false,
      applicationBundleAvailable: false,
      applicationBundlePath: null,
    };
  }
  return invoke<CleanupScanAccess>("get_cleanup_scan_access");
}

export async function openCleanupFullDiskAccessSettings(): Promise<void> {
  if (canUseDevelopmentMock()) return;
  return invoke<void>("open_cleanup_full_disk_access_settings");
}

export async function revealCleanupApplicationBundle(): Promise<void> {
  if (canUseDevelopmentMock()) return;
  return invoke<void>("reveal_cleanup_app_bundle");
}

export async function revealPath(path: string): Promise<void> {
  if (canUseDevelopmentMock()) return;
  return invoke<void>("reveal_path", { path });
}

export async function previewPath(path: string): Promise<void> {
  if (canUseDevelopmentMock()) return;
  return invoke<void>("preview_path", { path });
}

export async function resolveUserPath(path: string): Promise<string> {
  if (canUseDevelopmentMock()) return path;
  return invoke<string>("resolve_user_path", { path });
}

export async function prepareEjectRemovableVolume(mountPoint: string): Promise<string> {
  if (canUseDevelopmentMock()) return "development-eject-confirmation";
  return invoke<string>("prepare_eject_removable_volume", { mountPoint });
}

export async function ejectRemovableVolume(confirmationId: string): Promise<void> {
  if (canUseDevelopmentMock()) return;
  return invoke<void>("eject_removable_volume", { confirmationId });
}

export async function getStorageHealth(
  mountPoints: readonly string[],
  forceRefresh = false,
): Promise<StorageHealthSnapshot> {
  if (canUseDevelopmentMock()) {
    return {
      sampledAtMs: Date.now(),
      devices: mountPoints.map((mountPoint) => ({
        mountPoint,
        filesystem: null,
        source: null,
        smartStatus: "unknown",
        smartLabel: null,
        readOnly: null,
        internal: null,
        solidState: null,
        purgeableBytes: null,
        inspectionError: null,
        inspectedAtMs: Date.now(),
        cached: false,
      })),
    };
  }
  return invoke<StorageHealthSnapshot>("get_storage_health", {
    mountPoints,
    forceRefresh,
  });
}

export async function openDiskUtility(): Promise<void> {
  if (canUseDevelopmentMock()) return;
  return invoke<void>("open_disk_utility");
}

export async function openSystemSettings(
  destination: SystemSettingsDestination,
): Promise<void> {
  if (canUseDevelopmentMock()) return;
  return invoke<void>("open_system_settings", { destination });
}

export async function openProductPage(
  page: ProductPage,
  language: string | undefined = DEFAULT_LANGUAGE,
): Promise<void> {
  const normalizedLanguage: SupportedLanguage = normalizeLanguage(language);
  if (!isDesktopRuntime()) {
    window.open(productPageUrl(page, normalizedLanguage), "_blank", "noopener,noreferrer");
    return;
  }
  return invoke<void>("open_product_page", { page, language: normalizedLanguage });
}

export async function openProductIssue(
  title: string,
  body: string,
): Promise<void> {
  if (!isDesktopRuntime()) {
    const url = new URL("https://github.com/JimmyDaddy/corerobin-monitor/issues/new");
    url.searchParams.set("title", title);
    url.searchParams.set("body", body);
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  return invoke<void>("open_product_issue", { title, body });
}

export async function canRelaunchApplication(executablePath: string): Promise<boolean> {
  if (canUseDevelopmentMock()) return executablePath.includes(".app/");
  return invoke<boolean>("can_relaunch_application", { executablePath });
}

export async function writeHistoryExport(
  path: string,
  content: string,
): Promise<void> {
  if (!isDesktopRuntime()) {
    const type = path.toLocaleLowerCase().endsWith(".csv")
      ? "text/csv;charset=utf-8"
      : "application/json;charset=utf-8";
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([content], { type }));
    anchor.download = path.split(/[\\/]/).pop() || "corerobin-history.json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
    return;
  }
  await invoke<void>("write_history_export", { path, content });
}

export async function getInstalledApplications(
  language: string | undefined = DEFAULT_LANGUAGE,
  forceRefresh = false,
): Promise<ApplicationInventorySnapshot> {
  const normalizedLanguage = normalizeLanguage(language);
  const memory = applicationInventoryMemory.get(normalizedLanguage);
  if (!forceRefresh && memory && Date.now() - memory.receivedAtMs <= APPLICATION_INVENTORY_MEMORY_TTL_MS) {
    return cloneApplicationInventory(memory.snapshot, true);
  }
  const existing = applicationInventoryInFlight.get(normalizedLanguage);
  if (existing && (!forceRefresh || existing.forceRefresh)) {
    const snapshot = await existing.request;
    return cloneApplicationInventory(snapshot, snapshot.cached);
  }
  const request = fetchInstalledApplications(normalizedLanguage, forceRefresh);
  applicationInventoryInFlight.set(normalizedLanguage, { forceRefresh, request });
  try {
    const snapshot = await request;
    applicationInventoryMemory.set(normalizedLanguage, {
      receivedAtMs: Date.now(),
      snapshot,
    });
    return cloneApplicationInventory(snapshot, snapshot.cached);
  } finally {
    if (applicationInventoryInFlight.get(normalizedLanguage)?.request === request) {
      applicationInventoryInFlight.delete(normalizedLanguage);
    }
  }
}

async function fetchInstalledApplications(
  language: SupportedLanguage,
  forceRefresh: boolean,
): Promise<ApplicationInventorySnapshot> {
  if (import.meta.env.DEV && canUseDevelopmentMock()) {
    await new Promise((resolve) => window.setTimeout(resolve, 1_200));
    return getMockInstalledApplications();
  }
  return invoke<ApplicationInventorySnapshot>("get_installed_applications", {
    language,
    forceRefresh,
  });
}

function cloneApplicationInventory(
  snapshot: ApplicationInventorySnapshot,
  cached: boolean,
): ApplicationInventorySnapshot {
  return {
    ...snapshot,
    cached,
    applications: snapshot.applications.map((application) => ({ ...application })),
  };
}

export async function getApplicationUninstallPlan(
  applicationPath: string,
  language: string | undefined = DEFAULT_LANGUAGE,
): Promise<ApplicationUninstallPlan> {
  if (import.meta.env.DEV && canUseDevelopmentMock()) {
    return getMockApplicationUninstallPlan(applicationPath);
  }
  return invoke<ApplicationUninstallPlan>("get_application_uninstall_plan", {
    applicationPath,
    language: normalizeLanguage(language),
  });
}

export async function getTrashedApplications(
  language: string | undefined = DEFAULT_LANGUAGE,
): Promise<TrashedApplication[]> {
  if (canUseDevelopmentMock()) return [];
  return invoke<TrashedApplication[]>("get_trashed_applications", {
    language: normalizeLanguage(language),
  });
}

export async function getTrashedApplicationResidualPlan(
  applicationPath: string,
  language: string | undefined = DEFAULT_LANGUAGE,
): Promise<ApplicationUninstallPlan> {
  if (canUseDevelopmentMock()) {
    return getMockApplicationUninstallPlan(applicationPath);
  }
  return invoke<ApplicationUninstallPlan>(
    "get_trashed_application_residual_plan",
    {
      applicationPath,
      language: normalizeLanguage(language),
    },
  );
}

export async function executeNativeApplicationUninstall(
  planId: string,
): Promise<NativeApplicationUninstallResult> {
  if (canUseDevelopmentMock()) {
    return {
      outcome: "succeeded",
      exitCode: 0,
      message: "The operating system completed the uninstall request.",
    };
  }
  return invoke<NativeApplicationUninstallResult>(
    "execute_native_application_uninstall",
    { request: { planId } },
  );
}

export async function relaunchApplication(executablePath: string): Promise<void> {
  if (canUseDevelopmentMock()) return;
  return invoke<void>("relaunch_application", { executablePath });
}

export async function getCleanupPathState(path: string): Promise<CleanupPathState> {
  if (canUseDevelopmentMock()) {
    return { path, exists: true, modifiedAtMs: null };
  }
  return invoke<CleanupPathState>("get_cleanup_path_state", { path });
}

export async function getCleanupIndexedDirectory(
  request: CleanupIndexedDirectoryRequest,
): Promise<CleanupNode> {
  if (canUseDevelopmentMock()) {
    const findNode = (nodes: CleanupNode[]): CleanupNode | null => {
      for (const node of nodes) {
        if (node.id === request.directoryId) return node;
        const nested = findNode(node.children);
        if (nested) return nested;
      }
      return null;
    };
    const found = findNode([getMockCleanupScan().root]);
    if (found) return found;
    throw { code: "cleanup_index_node_missing", message: "The folder is unavailable." };
  }
  return invoke<CleanupNode>("get_cleanup_indexed_directory", { request });
}

export async function getCleanupIndexedChildren(
  request: CleanupIndexedChildrenRequest,
): Promise<CleanupIndexedChildrenPage> {
  if (canUseDevelopmentMock()) return { items: [], nextCursor: null };
  return invoke<CleanupIndexedChildrenPage>("get_cleanup_indexed_children", { request });
}

export async function getCleanupScanOverview(scanId: string): Promise<CleanupScan> {
  if (canUseDevelopmentMock()) return getMockCleanupScan();
  return invoke<CleanupScan>("get_cleanup_scan_overview", { scanId });
}

export async function applyCleanupIndexDeletions(
  request: CleanupIndexDeletionRequest,
): Promise<CleanupScan> {
  if (canUseDevelopmentMock()) return getMockCleanupScan();
  return invoke<CleanupScan>("apply_cleanup_index_deletions", { request });
}

export async function startCleanupDirectoryRefresh(
  request: CleanupDirectoryRefreshRequest,
): Promise<CleanupScanJobStatus> {
  if (canUseDevelopmentMock()) return startCleanupScan({
    profile: "complete",
    targetKind: "folder",
    targetPath: request.directoryId,
  });
  return invoke<CleanupScanJobStatus>("start_cleanup_directory_refresh", { request });
}

export async function getCleanupDirectoryRefreshJob(): Promise<CleanupScanJobStatus | null> {
  if (canUseDevelopmentMock()) return null;
  return invoke<CleanupScanJobStatus | null>("get_cleanup_directory_refresh_job");
}

export async function loadCleanupDirectoryRefreshResult(jobId: string): Promise<CleanupScan> {
  if (canUseDevelopmentMock()) return getMockCleanupScan();
  return invoke<CleanupScan>("load_cleanup_directory_refresh_result", { jobId });
}

export async function cancelCleanupDirectoryRefresh(): Promise<boolean> {
  if (canUseDevelopmentMock()) return true;
  return invoke<boolean>("cancel_cleanup_directory_refresh");
}

export async function loadPersistedCleanupScan(): Promise<CleanupScan | null> {
  if (canUseDevelopmentMock()) return null;
  return invoke<CleanupScan | null>("load_persisted_cleanup_scan");
}

export async function getCleanupScanIndexSummary(): Promise<CleanupScanIndexSummary> {
  if (canUseDevelopmentMock()) {
    return { available: false, byteSize: 0, scanCount: 0, updatedAtMs: null };
  }
  return invoke<CleanupScanIndexSummary>("get_cleanup_scan_index_summary");
}

export async function clearPersistedCleanupScan(): Promise<void> {
  if (canUseDevelopmentMock()) return;
  return invoke<void>("clear_persisted_cleanup_scan");
}

export async function analyzeQuickCleanup(): Promise<QuickCleanCategorySummary[]> {
  if (canUseDevelopmentMock()) {
    return [
      { category: "user_cache", byteSize: 1_240_000_000, itemCount: 18_420, skippedCount: 3, available: true },
      { category: "logs", byteSize: 96_000_000, itemCount: 2_104, skippedCount: 0, available: true },
      { category: "temp_files", byteSize: 512_000_000, itemCount: 8_870, skippedCount: 12, available: true },
      { category: "trash", byteSize: 230_000_000, itemCount: 96, skippedCount: 0, available: true },
    ];
  }
  return invoke<QuickCleanCategorySummary[]>("analyze_quick_cleanup_command");
}

export async function runQuickCleanup(
  categories: QuickCleanCategory[],
  onProgress: (progress: QuickCleanProgress) => void,
): Promise<QuickCleanResult> {
  if (canUseDevelopmentMock()) {
    const ticks: QuickCleanCategory[] = ["user_cache", "logs", "temp_files", "trash"];
    for (const category of ticks) {
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      onProgress({
        category,
        processedItemCount: 1,
        totalItemCount: 1,
        freedBytes: 1_000_000_000,
        freedItems: 1,
        skippedItems: 0,
        currentPath: category,
      });
    }
    return {
      freedBytes: 2_078_000_000,
      freedItems: 4,
      skippedItems: 0,
      results: [
        { category: "user_cache", freedBytes: 1_240_000_000, freedItems: 1, skippedItems: 0 },
        { category: "logs", freedBytes: 96_000_000, freedItems: 1, skippedItems: 0 },
        { category: "temp_files", freedBytes: 512_000_000, freedItems: 1, skippedItems: 0 },
        { category: "trash", freedBytes: 230_000_000, freedItems: 1, skippedItems: 0 },
      ],
    };
  }
  const progressChannel = new Channel<QuickCleanProgress>(onProgress);
  return invoke<QuickCleanResult>("run_quick_cleanup_command", {
    request: { categories },
    onProgress: progressChannel,
  });
}

export async function cancelQuickCleanup(): Promise<boolean> {
  if (canUseDevelopmentMock()) return false;
  return invoke<boolean>("cancel_quick_cleanup");
}

export async function clearPersistedProductData(): Promise<void> {
  applicationInventoryMemory.clear();
  if (canUseDevelopmentMock()) return;
  return invoke<void>("clear_persisted_product_data");
}

export async function loadPersistedApplicationHistory(): Promise<ApplicationHistoryStorage> {
  if (canUseDevelopmentMock()) {
    return { payload: null, byteSize: 0, updatedAtMs: null };
  }
  return invoke<ApplicationHistoryStorage>("load_persisted_application_history");
}

export async function savePersistedApplicationHistory(
  payload: string,
): Promise<ApplicationHistoryStorage> {
  if (canUseDevelopmentMock()) {
    return {
      payload: null,
      byteSize: new TextEncoder().encode(payload).byteLength,
      updatedAtMs: Date.now(),
    };
  }
  return invoke<ApplicationHistoryStorage>("save_persisted_application_history", {
    payload,
  });
}

export async function clearPersistedApplicationHistory(): Promise<void> {
  if (canUseDevelopmentMock()) return;
  return invoke<void>("clear_persisted_application_history");
}

export async function loadHistoryStorage(
  category: HistoryStorageCategory,
): Promise<HistorySegmentStorage> {
  if (canUseDevelopmentMock()) {
    return { payload: null, byteSize: 0, updatedAtMs: null };
  }
  return invoke<HistorySegmentStorage>("load_history_storage", { category });
}

export async function saveHistoryStorage(
  category: HistoryStorageCategory,
  payload: string,
): Promise<HistorySegmentStorage> {
  if (canUseDevelopmentMock()) {
    return {
      payload: null,
      byteSize: new TextEncoder().encode(payload).byteLength,
      updatedAtMs: Date.now(),
    };
  }
  return invoke<HistorySegmentStorage>("save_history_storage", {
    category,
    payload,
  });
}

export async function clearHistoryStorage(
  category: HistoryStorageCategory,
): Promise<HistorySegmentStorage> {
  if (canUseDevelopmentMock()) {
    return { payload: null, byteSize: 0, updatedAtMs: null };
  }
  return invoke<HistorySegmentStorage>("clear_history_storage", { category });
}

export async function getHistoryStorageSummary(): Promise<HistoryStorageSummary> {
  if (canUseDevelopmentMock()) {
    return { byteSize: 0, fileCount: 0, updatedAtMs: null };
  }
  return invoke<HistoryStorageSummary>("get_history_storage_summary");
}

export async function getProductDataCacheSummary(): Promise<ProductDataCacheSummary> {
  if (canUseDevelopmentMock()) {
    return {
      cleanupScan: { ...EMPTY_PRODUCT_DATA_CACHE_ITEM },
      fileInsights: { ...EMPTY_PRODUCT_DATA_CACHE_ITEM },
      applicationInventory: { ...EMPTY_PRODUCT_DATA_CACHE_ITEM },
      applicationHistory: { ...EMPTY_PRODUCT_DATA_CACHE_ITEM },
      historySegments: { ...EMPTY_PRODUCT_DATA_CACHE_ITEM },
    };
  }
  return invoke<ProductDataCacheSummary>("get_product_data_cache_summary");
}

export async function clearApplicationInventoryCache(): Promise<void> {
  applicationInventoryMemory.clear();
  if (canUseDevelopmentMock()) return;
  return invoke<void>("clear_application_inventory_cache");
}

export async function cancelCleanupScan(): Promise<boolean> {
  if (canUseDevelopmentMock()) {
    return true;
  }
  return invoke<boolean>("cancel_cleanup_scan");
}

export async function createCleanupDeleteLease(
  request: CleanupDeleteLeaseRequest,
): Promise<CleanupDeleteLease> {
  if (canUseDevelopmentMock()) {
    const lease = createMockCleanupDeleteLease(request);
    if (lease.executable) {
      mockCleanupDeletePaths.set(lease.id, lease.paths);
      mockCleanupDeleteModes.set(lease.id, lease.mode);
    }
    return lease;
  }
  return invoke<CleanupDeleteLease>("create_cleanup_delete_lease", { request });
}

export async function releaseCleanupDeleteLease(
  request: CleanupDeleteLeaseReleaseRequest,
): Promise<void> {
  if (canUseDevelopmentMock()) {
    releaseMockCleanupDeleteLease(request);
    mockCleanupDeletePaths.delete(request.leaseId);
    mockCleanupDeleteModes.delete(request.leaseId);
    return;
  }
  return invoke<void>("release_cleanup_delete_lease", { request });
}

export async function setCleanupDeleteLeaseMode(
  request: CleanupDeleteLeaseModeRequest,
): Promise<CleanupDeleteLease> {
  if (canUseDevelopmentMock()) {
    const lease = setMockCleanupDeleteLeaseMode(request);
    mockCleanupDeleteModes.set(lease.id, lease.mode);
    return lease;
  }
  return invoke<CleanupDeleteLease>("set_cleanup_delete_lease_mode", { request });
}

export async function executeCleanupDelete(
  request: CleanupDeleteExecutionRequest,
  onProgress: (progress: CleanupDeleteProgress) => void = () => {},
): Promise<CleanupDeleteResult> {
  if (canUseDevelopmentMock()) {
    mockCleanupDeleteCancelled = false;
    mockCleanupDeleteInFlight = true;
    const paths = mockCleanupDeletePaths.get(request.leaseId) ?? [];
    const mode = mockCleanupDeleteModes.get(request.leaseId) ?? "permanent";
    const currentPath = paths[0] ?? "";
    try {
      onProgress({
        phase: "preparing",
        processedEntryCount: 0,
        totalEntryCount: 0,
        completedTargetCount: 0,
        totalTargetCount: paths.length,
        currentPath,
        deletedBytes: 0,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 260));
      for (const processedEntryCount of [180, 430, 760, 1_000]) {
        if (mockCleanupDeleteCancelled) {
          releaseMockCleanupDeleteLease({ leaseId: request.leaseId });
          mockCleanupDeletePaths.delete(request.leaseId);
          mockCleanupDeleteModes.delete(request.leaseId);
          return { deleted: [], deletedBytes: 0, failed: [], cancelled: true, interruptedPath: null };
        }
        onProgress({
          phase: mode === "trash" ? "moving_to_trash" : "deleting",
          processedEntryCount,
          totalEntryCount: 1_000,
          completedTargetCount: 0,
          totalTargetCount: paths.length,
          currentPath,
          deletedBytes: 0,
        });
        await new Promise((resolve) => window.setTimeout(resolve, 140));
      }
      if (mockCleanupDeleteCancelled) {
        releaseMockCleanupDeleteLease({ leaseId: request.leaseId });
        mockCleanupDeletePaths.delete(request.leaseId);
        mockCleanupDeleteModes.delete(request.leaseId);
        return { deleted: [], deletedBytes: 0, failed: [], cancelled: true, interruptedPath: null };
      }
      mockCleanupDeletePaths.delete(request.leaseId);
      mockCleanupDeleteModes.delete(request.leaseId);
      return executeMockCleanupDelete(request);
    } finally {
      mockCleanupDeleteInFlight = false;
    }
  }
  const progressChannel = new Channel<CleanupDeleteProgress>(onProgress);
  return invoke<CleanupDeleteResult>("execute_cleanup_delete", { request, onProgress: progressChannel });
}

export async function cancelCleanupDelete(): Promise<boolean> {
  if (canUseDevelopmentMock()) {
    if (!mockCleanupDeleteInFlight) return false;
    mockCleanupDeleteCancelled = true;
    return true;
  }
  return invoke<boolean>("cancel_cleanup_delete");
}

export async function getProcessDetail(
  request: ProcessDetailRequest,
): Promise<ProcessDetail> {
  if (canUseDevelopmentMock()) {
    return getMockProcessDetail(request);
  }
  return invoke<ProcessDetail>("get_process_detail", { request });
}

export async function getApplicationIcon(
  request: ApplicationIconRequest,
): Promise<ApplicationIcon | null> {
  if (canUseDevelopmentMock()) return null;
  return invoke<ApplicationIcon | null>("get_application_icon", { request });
}

export async function executeProcessAction(
  request: ProcessActionRequest,
): Promise<ProcessActionResult> {
  if (canUseDevelopmentMock()) {
    return executeMockProcessAction(request);
  }
  return invoke<ProcessActionResult>("execute_process_action", { request });
}

export async function createProcessControlLease(
  request: ProcessControlLeaseRequest,
): Promise<ProcessControlLease> {
  if (canUseDevelopmentMock()) {
    return createMockProcessControlLease(request);
  }
  return invoke<ProcessControlLease>("create_process_control_lease", { request });
}

export async function releaseProcessControlLease(
  request: ProcessControlLeaseReleaseRequest,
): Promise<void> {
  if (canUseDevelopmentMock()) {
    releaseMockProcessControlLease(request);
    return;
  }
  return invoke<void>("release_process_control_lease", { request });
}
