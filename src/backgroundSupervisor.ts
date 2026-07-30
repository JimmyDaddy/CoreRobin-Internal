import type { DesktopNotificationStatus } from "./desktopNotifications";
import type { AppSettings } from "./settings";

export interface BackgroundSupervisorConfig {
  notificationsEnabled: boolean;
  notificationPermissionGranted: boolean;
  usageThresholds: [number, number, number];
  mutedResources: AppSettings["mutedNotificationResources"];
  applicationWatchRules: AppSettings["applicationWatchRules"];
  copies: {
    cpu: ResourceNotificationCopy;
    memory: ResourceNotificationCopy;
    volume: ResourceNotificationCopy;
    watch: {
      triggered: NotificationCopy;
      recovered: NotificationCopy;
      cpuMetric: string;
      memoryMetric: string;
      diskMetric: string;
    };
  };
}

interface NotificationCopy {
  title: string;
  body: string;
}

interface ResourceNotificationCopy {
  triggered: NotificationCopy;
  recovered: NotificationCopy;
}

type Translate = (key: string) => string;

export function buildBackgroundSupervisorConfig(
  settings: AppSettings,
  notificationStatus: DesktopNotificationStatus,
  translate: Translate,
): BackgroundSupervisorConfig {
  const resourceCopy = (
    resource: "cpu" | "memory" | "volume",
  ): ResourceNotificationCopy => ({
    triggered: {
      title: translate(`notifications:triggered.${resource}.title`),
      body: translate(`notifications:triggered.${resource}.body`),
    },
    recovered: {
      title: translate(`notifications:recovered.${resource}.title`),
      body: translate(`notifications:recovered.${resource}.body`),
    },
  });
  return {
    notificationsEnabled: settings.desktopNotificationsEnabled,
    notificationPermissionGranted: notificationStatus === "ready",
    usageThresholds: [...settings.usageThresholds],
    mutedResources: [...settings.mutedNotificationResources],
    applicationWatchRules: settings.applicationWatchRules.map((rule) => ({
      ...rule,
    })),
    copies: {
      cpu: resourceCopy("cpu"),
      memory: resourceCopy("memory"),
      volume: resourceCopy("volume"),
      watch: {
        triggered: {
          title: translate("notifications:watch.triggered.title"),
          body: translate("notifications:watch.triggered.body"),
        },
        recovered: {
          title: translate("notifications:watch.recovered.title"),
          body: translate("notifications:watch.recovered.body"),
        },
        cpuMetric: translate("notifications:watch.metric.cpu"),
        memoryMetric: translate("notifications:watch.metric.memory"),
        diskMetric: translate("notifications:watch.metric.disk"),
      },
    },
  };
}
