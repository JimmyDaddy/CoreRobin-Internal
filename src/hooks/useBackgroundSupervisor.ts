import { useEffect, useMemo } from "react";

import {
  buildBackgroundSupervisorConfig,
} from "../backgroundSupervisor";
import {
  configureBackgroundSupervisor,
  isDesktopRuntime,
} from "../api";
import type { DesktopNotificationStatus } from "../desktopNotifications";
import type { AppSettings } from "../settings";

export function useBackgroundSupervisor(
  settings: AppSettings,
  notificationStatus: DesktopNotificationStatus,
  translate: (key: string) => string,
): void {
  const config = useMemo(
    () => buildBackgroundSupervisorConfig(
      settings,
      notificationStatus,
      translate,
    ),
    [notificationStatus, settings, translate],
  );

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    void configureBackgroundSupervisor(config).catch(() => undefined);
  }, [config]);
}
