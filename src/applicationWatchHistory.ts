import type { HistoryRetentionDays } from "./historyStore";
import type {
  ApplicationWatchMetric,
  ApplicationWatchRule,
} from "./settings";

export const APPLICATION_WATCH_HISTORY_STORAGE_KEY =
  "core-robin.application-watch-history.v1";
export const MAX_APPLICATION_WATCH_HISTORY_EVENTS = 500;

export interface ApplicationWatchHistoryEvent {
  id: string;
  timestamp: number;
  kind: "triggered" | "recovered";
  ruleId: string;
  applicationName: string | null;
  metric: ApplicationWatchMetric;
  value: number;
  threshold: number;
  durationSeconds: number;
}

export function createApplicationWatchHistoryEvent(
  rule: ApplicationWatchRule,
  kind: ApplicationWatchHistoryEvent["kind"],
  value: number,
  timestamp: number,
  includeApplicationName: boolean,
): ApplicationWatchHistoryEvent {
  return {
    id: `watch-${rule.id}-${kind}-${timestamp}`,
    timestamp,
    kind,
    ruleId: rule.id,
    applicationName: includeApplicationName ? rule.applicationName : null,
    metric: rule.metric,
    value,
    threshold: rule.threshold,
    durationSeconds: rule.durationSeconds,
  };
}

export function mergeApplicationWatchHistory(
  current: readonly ApplicationWatchHistoryEvent[],
  incoming: readonly ApplicationWatchHistoryEvent[],
  now: number,
  retentionDays: HistoryRetentionDays,
): ApplicationWatchHistoryEvent[] {
  const cutoff = now - retentionDays * 86_400_000;
  const events = new Map<string, ApplicationWatchHistoryEvent>();
  for (const event of [...current, ...incoming]) {
    if (
      isApplicationWatchHistoryEvent(event) &&
      event.timestamp >= cutoff &&
      event.timestamp <= now
    ) {
      events.set(event.id, event);
    }
  }
  return [...events.values()]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-MAX_APPLICATION_WATCH_HISTORY_EVENTS);
}

export function loadApplicationWatchHistory(): ApplicationWatchHistoryEvent[] {
  try {
    return parseApplicationWatchHistory(
      window.localStorage.getItem(APPLICATION_WATCH_HISTORY_STORAGE_KEY),
    );
  } catch {
    return [];
  }
}

export function parseApplicationWatchHistory(
  payload: string | null,
): ApplicationWatchHistoryEvent[] {
  if (!payload) return [];
  try {
    const value = JSON.parse(payload) as unknown;
    return Array.isArray(value)
      ? value.filter(isApplicationWatchHistoryEvent)
          .slice(-MAX_APPLICATION_WATCH_HISTORY_EVENTS)
      : [];
  } catch {
    return [];
  }
}

export function serializeApplicationWatchHistory(
  events: readonly ApplicationWatchHistoryEvent[],
): string {
  return JSON.stringify(events.slice(-MAX_APPLICATION_WATCH_HISTORY_EVENTS));
}

export function saveApplicationWatchHistory(
  events: readonly ApplicationWatchHistoryEvent[],
): void {
  try {
    window.localStorage.setItem(
      APPLICATION_WATCH_HISTORY_STORAGE_KEY,
      serializeApplicationWatchHistory(events),
    );
  } catch {
    // Session history remains available when WebView persistence is unavailable.
  }
}

export function clearApplicationWatchHistory(): void {
  try {
    window.localStorage.removeItem(APPLICATION_WATCH_HISTORY_STORAGE_KEY);
  } catch {
    // Clearing the in-memory copy still removes it from the visible history.
  }
}

function isApplicationWatchHistoryEvent(
  value: unknown,
): value is ApplicationWatchHistoryEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<ApplicationWatchHistoryEvent>;
  return typeof event.id === "string" &&
    typeof event.timestamp === "number" &&
    Number.isFinite(event.timestamp) &&
    (event.kind === "triggered" || event.kind === "recovered") &&
    typeof event.ruleId === "string" &&
    (event.applicationName === null ||
      typeof event.applicationName === "string") &&
    (event.metric === "cpu" ||
      event.metric === "memory" ||
      event.metric === "disk") &&
    typeof event.value === "number" &&
    Number.isFinite(event.value) &&
    typeof event.threshold === "number" &&
    Number.isFinite(event.threshold) &&
    typeof event.durationSeconds === "number" &&
    Number.isFinite(event.durationSeconds);
}
