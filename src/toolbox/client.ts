import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { NetworkAddressesSnapshot } from "./network/networkTools";

import {
  TOOLBOX_CONTRACT_VERSION,
  type ToolboxEvent,
  type ToolboxError,
  type ToolboxJob,
  type ToolboxJobRequest,
  type ToolboxRequest,
  type ToolboxSnapshot,
  type ToolId,
  type ToolboxInputToken,
  type ToolboxFileJobKey,
  type ToolboxOutputToken,
  type OutputValidation,
} from "./contracts";

export const TOOLBOX_EVENT = "core-robin:toolbox-event";

export function newToolboxRequest(requestId = crypto.randomUUID()): ToolboxRequest {
  return { requestId };
}

export async function getToolboxSnapshot(): Promise<ToolboxSnapshot> {
  return invoke<ToolboxSnapshot>("get_toolbox_snapshot", { contractVersion: TOOLBOX_CONTRACT_VERSION });
}

/**
 * Keep the newest snapshot from the same native-service lifetime.
 *
 * A service instance establishes the revision sequence.  Accepting a higher
 * revision from a different instance would let a delayed event from an older
 * service overwrite the state that the current page is using.
 */
export function selectNewerToolboxSnapshot(
  current: ToolboxSnapshot | null,
  candidate: ToolboxSnapshot | null,
): ToolboxSnapshot | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  if (candidate.serviceInstanceId !== current.serviceInstanceId) return current;
  return candidate.revision >= current.revision ? candidate : current;
}

export function getToolboxNetworkSnapshot(): Promise<NetworkAddressesSnapshot> {
  return invoke("get_toolbox_network_snapshot");
}

export async function startToolboxSession(request: ToolboxJobRequest): Promise<ToolboxJob> {
  const snapshot = await getToolboxSnapshot();
  return invoke<ToolboxJob>("start_toolbox_session", { request: {
    ...request,
    generation: request.generation ?? 0,
    resetEpoch: request.resetEpoch ?? snapshot.resetEpoch,
  } });
}

export function prepareToolboxInputs(job: ToolboxFileJobKey, role: ToolboxInputToken["role"]): Promise<ToolboxInputToken[]> {
  return invoke("prepare_toolbox_inputs", { request: { job, role } });
}

export function readToolboxInput(job: ToolboxFileJobKey, token: string, offset: number, length: number): Promise<ArrayBuffer> {
  return invoke("read_toolbox_input", { request: { job, token, offset, length } });
}

export function releaseToolboxInputs(job: ToolboxFileJobKey, tokens: string[]): Promise<void> {
  return invoke("release_toolbox_inputs", { request: { job, tokens } });
}

export function revalidateToolboxInputs(job: ToolboxFileJobKey): Promise<void> {
  return invoke("revalidate_toolbox_inputs", { job });
}

export async function cancelToolboxJob(request: ToolboxRequest & { jobId: string }): Promise<ToolboxJob> {
  return invoke<ToolboxJob>("cancel_toolbox_job", { request });
}

export async function finishToolboxJob(request: ToolboxRequest & { jobId: string; succeeded: boolean; error?: ToolboxError | null }): Promise<ToolboxJob> {
  return invoke<ToolboxJob>("finish_toolbox_job", { request });
}

export async function registerToolboxOutput(request: ToolboxRequest & {
  jobId: string;
  generation: number;
  resetEpoch: number;
  bytes: Uint8Array;
  validation: OutputValidation;
}): Promise<ToolboxJob> {
  return invoke<ToolboxJob>("register_toolbox_output", { request });
}

export async function exportToolboxOutput(request: {
  requestId: string;
  jobId: string;
  outputToken: ToolboxOutputToken["token"];
  generation: number;
  resetEpoch: number;
  path: string;
}): Promise<ToolboxJob> {
  return invoke<ToolboxJob>("export_toolbox_output", { request });
}

export async function cancelToolboxOutput(request: {
  requestId: string;
  jobId: string;
  outputToken: ToolboxOutputToken["token"];
  generation: number;
  resetEpoch: number;
}): Promise<boolean> {
  return invoke<boolean>("cancel_toolbox_output", { request });
}

export async function clearToolboxData(request: ToolboxRequest): Promise<ToolboxSnapshot> {
  return invoke<ToolboxSnapshot>("clear_toolbox_data", { request });
}

export async function subscribeToolboxEvents(
  callback: (event: ToolboxEvent) => void,
): Promise<UnlistenFn> {
  return listen<ToolboxEvent>(TOOLBOX_EVENT, (event) => callback(event.payload));
}

export function isToolboxTool(value: string): value is ToolId {
  return value.length > 0;
}
