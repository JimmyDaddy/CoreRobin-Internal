import type { HistoryRetentionDays } from "./historyStore";
import {
  LEGACY_STORAGE_KEYS,
  readMigratedStorageItem,
  removeStorageItems,
} from "./storageMigration";
import { isProductDataResetInProgress } from "./productSupport";

export const USER_ACTION_HISTORY_STORAGE_KEY = "core-robin.user-action-history.v1";
export const MAX_USER_ACTION_RECORDS = 500;

export const USER_ACTION_KINDS = [
  "process_close",
  "process_restart",
  "process_force_quit",
  "cleanup_delete",
  "startup_disable",
  "startup_enable",
  "application_uninstall",
  "volume_eject",
  "application_update",
] as const;

export const USER_ACTION_STATUSES = [
  "running",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export const USER_ACTION_VERIFICATIONS = [
  "pending",
  "verified",
  "not_confirmed",
] as const;

export type UserActionKind = (typeof USER_ACTION_KINDS)[number];
export type UserActionStatus = (typeof USER_ACTION_STATUSES)[number];
export type UserActionVerification = (typeof USER_ACTION_VERIFICATIONS)[number];

export interface UserActionOutcome {
  selectedCount?: number;
  succeededCount?: number;
  skippedCount?: number;
  releasedBytes?: number;
  applicationRemoved?: boolean;
  residualSucceededCount?: number;
  residualFailedCount?: number;
  volumeUnmounted?: boolean;
  startupStateChanged?: boolean;
  processExited?: boolean;
  processRestarted?: boolean;
  updateDownloaded?: boolean;
  updateInstalled?: boolean;
  updateRestarted?: boolean;
  confirmedVersion?: string;
}

export interface UserActionRecord {
  id: string;
  kind: UserActionKind;
  status: UserActionStatus;
  verification: UserActionVerification;
  startedAtMs: number;
  completedAtMs: number | null;
  targetName: string | null;
  targetCount: number | null;
  affectedBytes: number | null;
  failedCount: number | null;
  outcome?: UserActionOutcome | null;
}

export interface StartUserActionInput {
  kind: UserActionKind;
  targetName?: string | null;
  targetCount?: number | null;
}

export interface CompleteUserActionInput {
  status: Exclude<UserActionStatus, "running">;
  verification: Exclude<UserActionVerification, "pending">;
  targetCount?: number | null;
  affectedBytes?: number | null;
  failedCount?: number | null;
  outcome?: UserActionOutcome | null;
}

interface UserActionHistoryPayload {
  version: 2;
  records: UserActionRecord[];
}

let nextActionSequence = 0;

export function createUserActionRecord(
  input: StartUserActionInput,
  now = Date.now(),
): UserActionRecord {
  nextActionSequence += 1;
  return {
    id: `action-${now}-${nextActionSequence}`,
    kind: input.kind,
    status: "running",
    verification: "pending",
    startedAtMs: now,
    completedAtMs: null,
    targetName: normalizeTargetName(input.targetName),
    targetCount: normalizeOptionalCount(input.targetCount),
    affectedBytes: null,
    failedCount: null,
    outcome: null,
  };
}

export function completeUserActionRecord(
  record: UserActionRecord,
  input: CompleteUserActionInput,
  now = Date.now(),
): UserActionRecord {
  return {
    ...record,
    status: input.status,
    verification: input.verification,
    completedAtMs: Math.max(record.startedAtMs, now),
    targetCount: input.targetCount === undefined
      ? record.targetCount
      : normalizeOptionalCount(input.targetCount),
    affectedBytes: normalizeOptionalCount(input.affectedBytes),
    failedCount: normalizeOptionalCount(input.failedCount),
    outcome: input.outcome === undefined
      ? record.outcome
      : normalizeOutcome(input.outcome),
  };
}

export function parseUserActionHistory(serialized: string | null): UserActionRecord[] {
  if (!serialized) return [];
  try {
    const value = JSON.parse(serialized) as unknown;
    if (
      !isRecord(value)
      || (value.version !== 1 && value.version !== 2)
      || !Array.isArray(value.records)
    ) {
      return [];
    }
    return deduplicateUserActionRecords(
      value.records
        .filter(isUserActionRecord)
        .map((record) => ({
          ...record,
          outcome: normalizeOutcome(record.outcome),
        })),
    );
  } catch {
    return [];
  }
}

export function loadUserActionHistory(): UserActionRecord[] {
  try {
    return parseUserActionHistory(
      readMigratedStorageItem(
        window.localStorage,
        USER_ACTION_HISTORY_STORAGE_KEY,
        LEGACY_STORAGE_KEYS.userActionHistory,
      ),
    );
  } catch {
    return [];
  }
}

export function saveUserActionHistory(records: readonly UserActionRecord[]): void {
  if (isProductDataResetInProgress()) return;
  try {
    window.localStorage.setItem(
      USER_ACTION_HISTORY_STORAGE_KEY,
      serializeUserActionHistory(records),
    );
  } catch {
    // The current session still keeps the action result when storage is blocked.
  }
}

export function serializeUserActionHistory(
  records: readonly UserActionRecord[],
): string {
  const payload: UserActionHistoryPayload = {
    version: 2,
    records: deduplicateUserActionRecords(records),
  };
  return JSON.stringify(payload);
}

export function clearUserActionHistoryStorage(): void {
  try {
    removeStorageItems(
      window.localStorage,
      USER_ACTION_HISTORY_STORAGE_KEY,
      LEGACY_STORAGE_KEYS.userActionHistory,
    );
  } catch {
    // Clearing the in-memory copy remains useful when storage is unavailable.
  }
}

export function mergeUserActionRecords(
  stored: readonly UserActionRecord[],
  incoming: readonly UserActionRecord[],
  now: number,
  retentionDays: HistoryRetentionDays,
): UserActionRecord[] {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1_000;
  return deduplicateUserActionRecords(
    [...stored, ...incoming].filter(
      (record) =>
        isUserActionRecord(record) &&
        record.startedAtMs >= cutoff &&
        record.startedAtMs <= now,
    ),
  );
}

export function redactUserActionTargetNames(
  records: readonly UserActionRecord[],
): UserActionRecord[] {
  return records.map((record) => ({ ...record, targetName: null }));
}

export function recoverInterruptedUserActions(
  records: readonly UserActionRecord[],
  now = Date.now(),
): UserActionRecord[] {
  return records.map((record) => record.status === "running"
    ? completeUserActionRecord(record, {
        status: "interrupted",
        verification: "not_confirmed",
      }, now)
    : record);
}

function deduplicateUserActionRecords(
  records: readonly UserActionRecord[],
): UserActionRecord[] {
  const latestById = new Map<string, UserActionRecord>();
  for (const record of records) latestById.set(record.id, record);
  return [...latestById.values()]
    .sort((left, right) => left.startedAtMs - right.startedAtMs)
    .slice(-MAX_USER_ACTION_RECORDS);
}

function isUserActionRecord(value: unknown): value is UserActionRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    USER_ACTION_KINDS.includes(value.kind as UserActionKind) &&
    USER_ACTION_STATUSES.includes(value.status as UserActionStatus) &&
    USER_ACTION_VERIFICATIONS.includes(value.verification as UserActionVerification) &&
    isFinitePositiveNumber(value.startedAtMs) &&
    (value.completedAtMs === null || (
      isFinitePositiveNumber(value.completedAtMs) &&
      value.completedAtMs >= value.startedAtMs
    )) &&
    (value.targetName === null || (
      typeof value.targetName === "string" &&
      value.targetName.length > 0 &&
      value.targetName.length <= 120
    )) &&
    isOptionalCount(value.targetCount) &&
    isOptionalCount(value.affectedBytes) &&
    isOptionalCount(value.failedCount) &&
    (value.outcome === undefined || value.outcome === null || isUserActionOutcome(value.outcome)) &&
    (value.status === "running"
      ? value.completedAtMs === null && value.verification === "pending"
      : value.completedAtMs !== null && value.verification !== "pending")
  );
}

function normalizeOutcome(
  value: UserActionOutcome | null | undefined,
): UserActionOutcome | null {
  if (!value || !isUserActionOutcome(value)) return null;
  return {
    ...copyOptionalCount(value, "selectedCount"),
    ...copyOptionalCount(value, "succeededCount"),
    ...copyOptionalCount(value, "skippedCount"),
    ...copyOptionalCount(value, "releasedBytes"),
    ...copyOptionalCount(value, "residualSucceededCount"),
    ...copyOptionalCount(value, "residualFailedCount"),
    ...copyOptionalBoolean(value, "applicationRemoved"),
    ...copyOptionalBoolean(value, "volumeUnmounted"),
    ...copyOptionalBoolean(value, "startupStateChanged"),
    ...copyOptionalBoolean(value, "processExited"),
    ...copyOptionalBoolean(value, "processRestarted"),
    ...copyOptionalBoolean(value, "updateDownloaded"),
    ...copyOptionalBoolean(value, "updateInstalled"),
    ...copyOptionalBoolean(value, "updateRestarted"),
    ...(typeof value.confirmedVersion === "string"
      && /^\d+\.\d+\.\d+$/.test(value.confirmedVersion)
      ? { confirmedVersion: value.confirmedVersion }
      : {}),
  };
}

function isUserActionOutcome(value: unknown): value is UserActionOutcome {
  if (!isRecord(value)) return false;
  return [
    "selectedCount",
    "succeededCount",
    "skippedCount",
    "releasedBytes",
    "residualSucceededCount",
    "residualFailedCount",
  ].every((key) => value[key] === undefined || isOptionalCount(value[key]))
    && [
      "applicationRemoved",
      "volumeUnmounted",
      "startupStateChanged",
      "processExited",
      "processRestarted",
      "updateDownloaded",
      "updateInstalled",
      "updateRestarted",
    ].every((key) => value[key] === undefined || typeof value[key] === "boolean")
    && (
      value.confirmedVersion === undefined
      || (
        typeof value.confirmedVersion === "string"
        && /^\d+\.\d+\.\d+$/.test(value.confirmedVersion)
      )
    );
}

function copyOptionalCount(
  value: UserActionOutcome,
  key: keyof UserActionOutcome,
): UserActionOutcome {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0
    ? { [key]: candidate }
    : {};
}

function copyOptionalBoolean(
  value: UserActionOutcome,
  key: keyof UserActionOutcome,
): UserActionOutcome {
  const candidate = value[key];
  return typeof candidate === "boolean" ? { [key]: candidate } : {};
}

function normalizeTargetName(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().slice(0, 120);
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function isOptionalCount(value: unknown): value is number | null {
  return value === null || (
    typeof value === "number" && Number.isFinite(value) && value >= 0
  );
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
