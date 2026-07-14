import type { SupportedLanguage } from "./i18n";
import type { ResourceAlertEvent } from "./resourceAlerts";

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

export const DESKTOP_NOTIFICATION_LOG_KEY = "pulse.desktop-notification-log.v1";
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
    const value = JSON.parse(window.localStorage.getItem(DESKTOP_NOTIFICATION_LOG_KEY) ?? "[]") as unknown;
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

export function desktopNotificationCopy(
  event: ResourceAlertEvent,
  language: SupportedLanguage,
): DesktopNotificationCopy {
  const zh = language === "zh-CN";
  if (event.kind === "recovered") {
    if (event.resource === "cpu") {
      return {
        title: zh ? "电脑负荷已经恢复" : "Computer load has returned to normal",
        body: zh
          ? "处理器已稳定回到正常范围，之前的卡顿、发热或耗电影响应该正在缓解。"
          : "Processor use has stayed back in the normal range. The earlier slowness, heat, or power impact should now be easing.",
      };
    }
    if (event.resource === "memory") {
      return {
        title: zh ? "内存压力已经缓解" : "Memory pressure has eased",
        body: zh
          ? "可用内存和交换活动已经稳定恢复，切换应用应该会更顺畅。"
          : "Available memory and swap activity have stayed back in a healthy range, so switching apps should feel smoother.",
      };
    }
    return {
      title: zh ? "磁盘空间状态已经恢复" : "Disk space is back in a healthy range",
      body: zh
        ? "磁盘占用已稳定回到安全范围，目前不需要继续清理。"
        : "Disk usage has stayed back in a safe range, so no further cleanup is needed right now.",
    };
  }
  if (event.resource === "cpu") {
    return {
      title: zh ? "电脑持续处于高负荷" : "The computer is staying under heavy load",
      body: zh
        ? "处理器持续繁忙，可能导致卡顿、发热或更耗电。打开 Pulse 可查看影响最大的应用。"
        : "The processor has stayed busy and may cause slowness, heat, or extra battery use. Open Pulse to see the biggest app impact.",
    };
  }
  if (event.resource === "memory") {
    return {
      title: zh ? "可用内存持续紧张" : "Available memory is staying tight",
      body: zh
        ? "低可用内存与明显交换活动同时出现，切换应用可能变慢。Pulse 不会自动关闭应用。"
        : "Low available memory and meaningful swap activity are happening together. Pulse will never close apps automatically.",
    };
  }
  return {
    title: zh ? "磁盘剩余空间偏少" : "Disk free space is running low",
    body: zh
      ? "磁盘占用持续超过 85%。可以先打开清理页查看空间地图，文件处理仍需你确认。"
      : "Disk usage has stayed above 85%. Inspect the Cleanup space map first; every file action still requires confirmation.",
  };
}
