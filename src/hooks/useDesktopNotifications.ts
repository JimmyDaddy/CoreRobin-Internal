import { useEffect, useRef, useState } from "react";

import {
  desktopNotificationCopy,
  loadDesktopNotificationLog,
  saveDesktopNotificationLog,
  selectNotificationsWithinDailyBudget,
  type DesktopNotificationStatus,
} from "../desktopNotifications";
import type { SupportedLanguage } from "../i18n";
import type { ResourceAlertEvent } from "../resourceAlerts";
import type { ResourceAlertResource } from "../resourceAlerts";
import { isDesktopRuntime } from "../api";
import {
  createSeenResourceAlertIds,
  reconcileSeenResourceAlertIds,
} from "../desktopNotificationSeenIds";

export function useDesktopNotifications(
  events: readonly ResourceAlertEvent[],
  enabled: boolean,
  language: SupportedLanguage,
  mutedResources: readonly ResourceAlertResource[],
  onOpenEvidence: (resource: ResourceAlertResource) => void,
) {
  const seenIds = useRef(createSeenResourceAlertIds(events));
  const sentAtMs = useRef(loadDesktopNotificationLog());
  const [status, setStatus] = useState<DesktopNotificationStatus>(
    enabled ? "requesting" : "disabled",
  );

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setStatus("disabled");
      return;
    }
    if (!isDesktopRuntime()) {
      setStatus("unavailable");
      return;
    }
    setStatus("requesting");
    void ensureNotificationPermission().then((granted) => {
      if (!cancelled) setStatus(granted ? "ready" : "denied");
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/plugin-notification")
      .then(({ onAction }) => onAction((notification) => {
        const resource = notification.extra?.statusOrbitResource;
        if (resource === "cpu" || resource === "memory" || resource === "volume") {
          onOpenEvidence(resource);
        }
      }))
      .then((listener) => {
        if (disposed) listener.unregister();
        else unlisten = () => listener.unregister();
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, onOpenEvidence]);

  useEffect(() => {
    const unseen = reconcileSeenResourceAlertIds(seenIds.current, events);
    if (!enabled || status !== "ready") return;
    const now = Date.now();
    const selected = selectNotificationsWithinDailyBudget(
      unseen.filter((event) => !mutedResources.includes(event.resource)),
      sentAtMs.current,
      now,
    );
    selected.forEach((event) => {
      void sendResourceNotification(event, language);
    });
    if (selected.length > 0) {
      sentAtMs.current = [...sentAtMs.current, ...selected.map(() => now)];
      saveDesktopNotificationLog(sentAtMs.current);
    }
  }, [enabled, events, language, mutedResources, status]);

  return { status };
}

async function ensureNotificationPermission() {
  try {
    const { isPermissionGranted, requestPermission } = await import(
      "@tauri-apps/plugin-notification"
    );
    if (await isPermissionGranted()) return true;
    return await requestPermission() === "granted";
  } catch {
    return false;
  }
}

async function sendResourceNotification(
  event: ResourceAlertEvent,
  language: SupportedLanguage,
) {
  try {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    sendNotification({
      ...desktopNotificationCopy(event, language),
      autoCancel: true,
      extra: { statusOrbitResource: event.resource },
    });
  } catch {
    // The event remains available in History even if the OS rejects a toast.
  }
}
