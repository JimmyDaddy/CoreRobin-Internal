import {
  RESOURCE_ALERT_RESOURCES,
  type ResourceAlertEvent,
} from "./resourceAlerts";
import type { HistoryRetentionDays } from "./historyStore";

export const RESOURCE_ALERT_STORAGE_KEY = "pulse.resource-alert-events.v1";
export const MAX_RESOURCE_ALERT_EVENTS = 5_000;

interface ResourceAlertPayload {
  version: 1;
  events: ResourceAlertEvent[];
}

export function parseResourceAlertEvents(
  serialized: string | null,
): ResourceAlertEvent[] {
  if (!serialized) return [];
  try {
    const value = JSON.parse(serialized) as unknown;
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.events)) {
      return [];
    }
    return deduplicateEvents(value.events.filter(isResourceAlertEvent));
  } catch {
    return [];
  }
}

export function loadResourceAlertEvents(): ResourceAlertEvent[] {
  try {
    return parseResourceAlertEvents(
      window.localStorage.getItem(RESOURCE_ALERT_STORAGE_KEY),
    );
  } catch {
    return [];
  }
}

export function saveResourceAlertEvents(
  events: readonly ResourceAlertEvent[],
): void {
  try {
    const payload: ResourceAlertPayload = {
      version: 1,
      events: deduplicateEvents(events.filter(isResourceAlertEvent)),
    };
    window.localStorage.setItem(
      RESOURCE_ALERT_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch {
    // Alert events stay available for this session if WebView storage is blocked.
  }
}

export function clearResourceAlertStorage(): void {
  try {
    window.localStorage.removeItem(RESOURCE_ALERT_STORAGE_KEY);
  } catch {
    // Clearing the in-memory saved copy still provides the expected UI behavior.
  }
}

export function mergeResourceAlertEvents(
  stored: readonly ResourceAlertEvent[],
  incoming: readonly ResourceAlertEvent[],
  now: number,
  retentionDays: HistoryRetentionDays,
): ResourceAlertEvent[] {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1_000;
  return deduplicateEvents(
    [...stored, ...incoming].filter(
      (event) =>
        isResourceAlertEvent(event) &&
        event.timestamp >= cutoff &&
        event.timestamp <= now,
    ),
  );
}

function deduplicateEvents(
  events: readonly ResourceAlertEvent[],
): ResourceAlertEvent[] {
  const latestById = new Map<string, ResourceAlertEvent>();
  for (const event of events) {
    latestById.set(event.id, event);
  }
  return [...latestById.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-MAX_RESOURCE_ALERT_EVENTS);
}

function isResourceAlertEvent(value: unknown): value is ResourceAlertEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isFinitePositiveNumber(value.timestamp) &&
    RESOURCE_ALERT_RESOURCES.includes(
      value.resource as (typeof RESOURCE_ALERT_RESOURCES)[number],
    ) &&
    (value.kind === "triggered" || value.kind === "recovered") &&
    (value.severity === "high" || value.severity === "critical") &&
    isPercentage(value.valuePercent) &&
    isPercentage(value.thresholdPercent) &&
    isFinitePositiveNumber(value.startedAtMs) &&
    isFiniteNonNegativeNumber(value.durationMs) &&
    value.startedAtMs <= value.timestamp &&
    (value.peakValuePercent === undefined || isPercentage(value.peakValuePercent)) &&
    (value.peakAtMs === undefined || (
      isFinitePositiveNumber(value.peakAtMs) &&
      value.peakAtMs >= value.startedAtMs &&
      value.peakAtMs <= value.timestamp
    )) &&
    (value.culpritName === undefined || value.culpritName === null || (
      typeof value.culpritName === "string" &&
      value.culpritName.length > 0 &&
      value.culpritName.length <= 120
    ))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPercentage(value: unknown): value is number {
  return isFiniteNonNegativeNumber(value) && value <= 100;
}
