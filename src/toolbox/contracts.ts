/**
 * Shared contract for the Toolbox surface.
 *
 * This file intentionally contains no React or Tauri implementation details.
 * It is the boundary every tool module uses so that page lifecycle and native
 * job lifecycle cannot silently diverge.
 */

export const TOOLBOX_CONTRACT_VERSION = "toolbox-v1" as const;

export type ToolboxCategory = "system-network" | "text-development" | "image" | "file-patch";

export type ToolId =
  | "json"
  | "url"
  | "base64"
  | "time"
  | "uuid"
  | "qr-code"
  | "text-sha256"
  | "file-sha256"
  | "regex"
  | "color"
  | "color-picker"
  | "keep-awake"
  | "process-watch"
  | "file-occupancy"
  | "volume-occupancy"
  | "keyboard-cleaning"
  | "schedules"
  | "network-addresses"
  | "ifconfig-parser"
  | "image-watermark"
  | "image-batch-watermark"
  | "confidential-watermark"
  | "image-recipe"
  | "image-editor"
  | "invisible-watermark-write"
  | "invisible-watermark-check"
  | "recipient-tracking"
  | "robustness-lab"
  | "c2pa-inspector"
  | "binary-patch-create"
  | "binary-patch-apply"
  | "binary-patch-inspector"
  | "integrity-manifest"
  | "transfer-savings"
  | "patch-errors"
  | "patch-planner";

export type SessionStatus = "preparing" | "running" | "stopping" | "ended";
export type ResourceStatus = "acquiring" | "active" | "releasing" | "released" | "release_unconfirmed";
export type JobStatus =
  | "queued"
  | "running"
  | "output_ready"
  | "exporting"
  | "stopping"
  | "completed"
  | "cancelled"
  | "expired"
  | "failed";

export type OutputValidation = "unverified" | "verified" | "failed";

export type TerminalReason =
  | "completed"
  | "cancelled"
  | "expired"
  | "failed"
  | "deadline"
  | "interrupted"
  | "unknown"
  | "release_unconfirmed";

export interface ToolboxError {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, string | number | boolean | null>;
}

export interface ToolboxCapability {
  state: "available" | "unavailable" | "degraded";
  reason: string | null;
  platform: string | null;
}

export interface ToolboxSession {
  sessionId: string;
  toolId: ToolId;
  status: SessionStatus;
  generation: number;
  createdAtMs: number;
  terminalReason: TerminalReason | null;
}

export interface ToolboxResource {
  resourceId: string;
  sessionId: string;
  status: ResourceStatus;
  bytesReserved: number;
  releaseConfirmed: boolean;
}

export interface ToolboxJob {
  jobId: string;
  sessionId: string;
  status: JobStatus;
  generation: number;
  resetEpoch: number;
  outputExpiresAtMs: number | null;
  outputToken: ToolboxOutputToken | null;
  terminalReason: TerminalReason | null;
  error: ToolboxError | null;
}

export interface ToolboxSnapshot {
  contractVersion: typeof TOOLBOX_CONTRACT_VERSION;
  serviceInstanceId: string;
  revision: number;
  resetEpoch: number;
  sessions: ToolboxSession[];
  resources: ToolboxResource[];
  jobs: ToolboxJob[];
  capabilities: Record<ToolId, ToolboxCapability>;
}

export interface ToolboxRequest {
  requestId: string;
  expectedRevision?: number;
  generation?: number;
  resetEpoch?: number;
}

export interface ToolboxJobRequest extends ToolboxRequest {
  toolId: ToolId;
  sessionId?: string;
}

export interface ToolboxInputToken {
  token: string;
  jobId: string;
  sessionId: string;
  generation: number;
  resetEpoch: number;
  role: "input" | "target" | "expected" | "logo" | "font" | "patch" | "manifest";
  displayName: string;
  byteLength: number;
  fileIdentity?: {
    pathHint: string;
    size: number;
    modifiedAtMs: number | null;
    identity: string;
  };
}

/** Additive file protocol v1. Every IO request is bound to the owning job. */
export interface ToolboxFileJobKey {
  jobId: string;
  generation: number;
  resetEpoch: number;
}

export interface ToolboxOutputToken {
  token: string;
  jobId: string;
  generation: number;
  resetEpoch: number;
  byteLength: number;
  expiresAtMs: number;
  validation: OutputValidation;
}

export interface ToolboxProgress {
  jobId: string;
  generation: number;
  completed: number;
  total: number | null;
  phase: string;
}

export type ToolboxEvent =
  | { type: "snapshot"; snapshot: ToolboxSnapshot }
  | { type: "job_progress"; progress: ToolboxProgress }
  | { type: "job_changed"; job: ToolboxJob; revision: number; serviceInstanceId: string }
  | { type: "navigation_ack"; requestId: string; accepted: boolean; reason: string | null };

export interface ToolPageProps {
  toolId: ToolId;
  generation: number;
  onNavigateBack: () => void;
  onGenerationChange?: (generation: number) => void;
}

export interface ToolDefinition {
  id: ToolId;
  category: ToolboxCategory;
  title: string;
  aliases: readonly string[];
  description: string;
  capability: ToolboxCapability;
  load: () => Promise<unknown>;
}

export function isTerminalJobStatus(status: JobStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "expired" || status === "failed";
}

export function isTerminalSessionStatus(status: SessionStatus): boolean {
  return status === "ended";
}

export function acceptsRevision(snapshot: ToolboxSnapshot, event: Pick<ToolboxEvent & { type: "job_changed" }, "revision" | "serviceInstanceId">): boolean {
  return event.serviceInstanceId === snapshot.serviceInstanceId && event.revision >= snapshot.revision;
}
