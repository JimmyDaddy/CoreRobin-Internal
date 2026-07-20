import { Channel, invoke } from "@tauri-apps/api/core";

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
  releaseMockStartupManagementLease,
} from "./mockData";
import type {
  ApplicationIcon,
  ApplicationIconRequest,
  ApplicationInventorySnapshot,
  ApplicationUninstallPlan,
  CleanupNode,
  CleanupPathState,
  CleanupScan,
  CleanupScanAccess,
  CleanupScanProgress,
  CleanupSubtreeRequest,
  CleanupDeleteExecutionRequest,
  CleanupDeleteLease,
  CleanupDeleteLeaseReleaseRequest,
  CleanupDeleteLeaseRequest,
  CleanupDeleteProgress,
  CleanupDeleteResult,
  ProcessActionRequest,
  ProcessActionResult,
  ProcessControlLease,
  ProcessControlLeaseReleaseRequest,
  ProcessControlLeaseRequest,
  ProcessDetail,
  ProcessDetailRequest,
  NetworkConnectionsSnapshot,
  NetworkHostLookup,
  NetworkQualityResult,
  StartupContext,
  FileInsightsProgress,
  FileInsightsScan,
  GpuEnergySnapshot,
  SystemSnapshot,
  SystemSummary,
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
  HealthStateSnapshot,
  HealthStateUpdate,
} from "./healthState";

let mockCleanupCancelled = false;
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

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
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
      targetHost: "example.com",
      targetPort: 443,
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
      packetLossPercent: 0,
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

export async function getCleanupScan(
  onProgress: (progress: CleanupScanProgress) => void,
): Promise<CleanupScan> {
  if (canUseDevelopmentMock()) {
    mockCleanupCancelled = false;
    const steps: CleanupScanProgress[] = [
      { scannedEntryCount: 640, discoveredBytes: 1_280_000_000, currentPath: "~/Downloads", elapsedMs: 180 },
      { scannedEntryCount: 6_420, discoveredBytes: 5_460_000_000, currentPath: "~/Library/Caches", elapsedMs: 520 },
      { scannedEntryCount: 15_680, discoveredBytes: 9_840_000_000, currentPath: "~/.cargo/registry", elapsedMs: 980 },
      { scannedEntryCount: 21_104, discoveredBytes: 17_430_000_000, currentPath: "~/.config", elapsedMs: 1_480 },
    ];
    for (const step of steps) {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      if (mockCleanupCancelled) {
        throw { code: "cleanup_scan_cancelled", message: "The cleanup scan was cancelled." };
      }
      onProgress(step);
    }
    return getMockCleanupScan();
  }
  const progressChannel = new Channel<CleanupScanProgress>(onProgress);
  return invoke<CleanupScan>("get_cleanup_scan", { onProgress: progressChannel });
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

export async function canRelaunchApplication(executablePath: string): Promise<boolean> {
  if (canUseDevelopmentMock()) return executablePath.includes(".app/");
  return invoke<boolean>("can_relaunch_application", { executablePath });
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
  if (canUseDevelopmentMock()) {
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
  if (canUseDevelopmentMock()) return getMockApplicationUninstallPlan(applicationPath);
  return invoke<ApplicationUninstallPlan>("get_application_uninstall_plan", {
    applicationPath,
    language: normalizeLanguage(language),
  });
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

export async function getCleanupSubtree(
  request: CleanupSubtreeRequest,
): Promise<CleanupNode> {
  if (canUseDevelopmentMock()) {
    const findNode = (nodes: CleanupNode[]): CleanupNode | null => {
      for (const node of nodes) {
        if (node.path === request.path) return node;
        const nested = findNode(node.children);
        if (nested) return nested;
      }
      return null;
    };
    const found = findNode([getMockCleanupScan().root]);
    if (found) return found;
    throw { code: "cleanup_subtree_unavailable", message: "The folder is unavailable." };
  }
  return invoke<CleanupNode>("get_cleanup_subtree", { request });
}

export async function loadPersistedCleanupScan(): Promise<string | null> {
  if (canUseDevelopmentMock()) return null;
  return invoke<string | null>("load_persisted_cleanup_scan");
}

export async function savePersistedCleanupScan(snapshot: CleanupScan): Promise<void> {
  if (canUseDevelopmentMock()) return;
  return invoke<void>("save_persisted_cleanup_scan", { snapshot });
}

export async function clearPersistedCleanupScan(): Promise<void> {
  if (canUseDevelopmentMock()) return;
  return invoke<void>("clear_persisted_cleanup_scan");
}

export async function cancelCleanupScan(): Promise<boolean> {
  if (canUseDevelopmentMock()) {
    mockCleanupCancelled = true;
    return true;
  }
  return invoke<boolean>("cancel_cleanup_scan");
}

export async function cancelCleanupSubtree(requestId: string): Promise<boolean> {
  if (canUseDevelopmentMock()) return true;
  return invoke<boolean>("cancel_cleanup_subtree", { requestId });
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
