import { invoke } from "@tauri-apps/api/core";

import {
  createMockProcessControlLease,
  executeMockProcessAction,
  getMockProcessDetail,
  getMockSnapshot,
  releaseMockProcessControlLease,
} from "./mockData";
import type {
  ProcessActionRequest,
  ProcessActionResult,
  ProcessControlLease,
  ProcessControlLeaseReleaseRequest,
  ProcessControlLeaseRequest,
  ProcessDetail,
  ProcessDetailRequest,
  SystemSnapshot,
} from "./types";

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

export async function getProcessDetail(
  request: ProcessDetailRequest,
): Promise<ProcessDetail> {
  if (canUseDevelopmentMock()) {
    return getMockProcessDetail(request);
  }
  return invoke<ProcessDetail>("get_process_detail", { request });
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
