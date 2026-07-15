import { Channel, invoke } from "@tauri-apps/api/core";

import {
  createMockCleanupDeleteLease,
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
  SystemSnapshot,
  SystemSummary,
  StartupItemsSnapshot,
  StartupManagementExecutionRequest,
  StartupManagementLease,
  StartupManagementLeaseReleaseRequest,
  StartupManagementLeaseRequest,
  StartupManagementResult,
} from "./types";

let mockCleanupCancelled = false;
let mockCleanupDeleteCancelled = false;
let mockCleanupDeleteInFlight = false;
const mockCleanupDeletePaths = new Map<string, string[]>();

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
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
      sampledAtMs: snapshot.sampledAtMs,
      cpu: snapshot.cpu,
      memory: snapshot.memory,
      volumes: snapshot.disk.volumes,
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
        applicationBundlePath: demo === "cleanup-access" ? "/Applications/StatusOrbit.app" : null,
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
    if (lease.executable) mockCleanupDeletePaths.set(lease.id, lease.paths);
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
          return { deleted: [], deletedBytes: 0, failed: [], cancelled: true, interruptedPath: null };
        }
        onProgress({
          phase: "deleting",
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
        return { deleted: [], deletedBytes: 0, failed: [], cancelled: true, interruptedPath: null };
      }
      mockCleanupDeletePaths.delete(request.leaseId);
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
  request: ProcessDetailRequest,
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
