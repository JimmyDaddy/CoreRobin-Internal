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
  CleanupScanProgress,
  CleanupSubtreeRequest,
  CleanupDeleteExecutionRequest,
  CleanupDeleteLease,
  CleanupDeleteLeaseReleaseRequest,
  CleanupDeleteLeaseRequest,
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
  StartupItemsSnapshot,
  StartupManagementExecutionRequest,
  StartupManagementLease,
  StartupManagementLeaseReleaseRequest,
  StartupManagementLeaseRequest,
  StartupManagementResult,
} from "./types";

let mockCleanupCancelled = false;

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
    const found = findNode(getMockCleanupScan().locations.flatMap((location) => location.nodes));
    if (found) return found;
    throw { code: "cleanup_subtree_unavailable", message: "The folder is unavailable." };
  }
  return invoke<CleanupNode>("get_cleanup_subtree", { request });
}

export async function loadPersistedCleanupScan(): Promise<string | null> {
  if (canUseDevelopmentMock()) return null;
  return invoke<string | null>("load_persisted_cleanup_scan");
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

export async function createCleanupDeleteLease(
  request: CleanupDeleteLeaseRequest,
): Promise<CleanupDeleteLease> {
  if (canUseDevelopmentMock()) return createMockCleanupDeleteLease(request);
  return invoke<CleanupDeleteLease>("create_cleanup_delete_lease", { request });
}

export async function releaseCleanupDeleteLease(
  request: CleanupDeleteLeaseReleaseRequest,
): Promise<void> {
  if (canUseDevelopmentMock()) {
    releaseMockCleanupDeleteLease(request);
    return;
  }
  return invoke<void>("release_cleanup_delete_lease", { request });
}

export async function executeCleanupDelete(
  request: CleanupDeleteExecutionRequest,
): Promise<CleanupDeleteResult> {
  if (canUseDevelopmentMock()) return executeMockCleanupDelete(request);
  return invoke<CleanupDeleteResult>("execute_cleanup_delete", { request });
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
