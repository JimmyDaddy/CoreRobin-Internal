import type { SupportedLanguage } from "./i18n";
import { translateNotification } from "./i18n/notificationTranslator";
import type { ResourceAlertEvent } from "./resourceAlerts";
import {
  LEGACY_STORAGE_KEYS,
  readMigratedStorageItem,
} from "./storageMigration";

export type DesktopNotificationStatus =
  | "disabled"
  | "requesting"
  | "ready"
  | "denied"
  | "unavailable";

export interface DesktopNotificationCopy {
  title: string;
  body: string;
}

export const DESKTOP_NOTIFICATION_LOG_KEY = "status-orbit.desktop-notification-log.v1";
export const MAX_DESKTOP_NOTIFICATIONS_PER_DAY = 4;

export function selectNotificationsWithinDailyBudget(
  events: readonly ResourceAlertEvent[],
  sentAtMs: readonly number[],
  now = Date.now(),
  limit = MAX_DESKTOP_NOTIFICATIONS_PER_DAY,
): ResourceAlertEvent[] {
  const dayStart = localDayStart(now);
  const sentToday = sentAtMs.filter((timestamp) => timestamp >= dayStart && timestamp <= now).length;
  const remaining = Math.max(0, limit - sentToday);
  return events.filter(shouldSendDesktopNotification).slice(0, remaining);
}

export function loadDesktopNotificationLog(now = Date.now()): number[] {
  try {
    const value = JSON.parse(readMigratedStorageItem(
      window.localStorage,
      DESKTOP_NOTIFICATION_LOG_KEY,
      LEGACY_STORAGE_KEYS.desktopNotificationLog,
    ) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    const dayStart = localDayStart(now);
    return value.filter((timestamp): timestamp is number =>
      typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp >= dayStart && timestamp <= now
    );
  } catch {
    return [];
  }
}

export function saveDesktopNotificationLog(sentAtMs: readonly number[]): void {
  try {
    window.localStorage.setItem(DESKTOP_NOTIFICATION_LOG_KEY, JSON.stringify(sentAtMs));
  } catch {
    // The in-memory budget still prevents duplicate interruptions this session.
  }
}

function localDayStart(now: number): number {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function shouldSendDesktopNotification(event: ResourceAlertEvent): boolean {
  if (event.resource === "cpu") return event.severity === "critical";
  return true;
}

export async function desktopNotificationCopy(
  event: ResourceAlertEvent,
  language: SupportedLanguage,
): Promise<DesktopNotificationCopy> {
  return {
    title: await translateNotification(
      language,
      `${event.kind}.${event.resource}.title`,
    ),
    body: await translateNotification(
      language,
      `${event.kind}.${event.resource}.body`,
    ),
  };
}
