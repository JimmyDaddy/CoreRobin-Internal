import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  deliverDesktopNotification,
  desktopNotificationCopy,
  desktopNotificationTestCopy,
  loadDesktopNotificationLog,
  saveDesktopNotificationLog,
  selectNotificationsWithinDailyBudget,
  type DesktopNotificationStatus,
  type DesktopNotificationDelivery,
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
  const [delivery, setDelivery] =
    useState<DesktopNotificationDelivery | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const desktop = isDesktopRuntime();

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
    if (!desktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<DesktopNotificationDelivery>(
      "core-robin:supervisor-notification",
      ({ payload }) => {
        if (!disposed) setDelivery(payload);
      },
    ).then((listener) => {
      if (disposed) listener();
      else unlisten = listener;
    }).catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktop]);

  useEffect(() => {
    if (!enabled || !isDesktopRuntime()) return;
    let disposed = false;
    const refreshPermission = () => {
      if (document.visibilityState !== "visible") return;
      void isNotificationPermissionGranted().then((granted) => {
        if (disposed) return;
        if (granted && statusRef.current !== "ready") {
          for (const event of activeTriggeredAlerts(events)) {
            seenIds.current.delete(event.id);
          }
        }
        setStatus(granted ? "ready" : "denied");
      });
    };
    window.addEventListener("focus", refreshPermission);
    document.addEventListener("visibilitychange", refreshPermission);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refreshPermission);
      document.removeEventListener("visibilitychange", refreshPermission);
    };
  }, [enabled, events]);

  useEffect(() => {
    if (!enabled || !isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/plugin-notification")
      .then(({ onAction }) => onAction((notification) => {
        const resource = notification.extra?.coreRobinResource;
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
    if (!enabled || status !== "ready" || desktop) return;
    const unseen = reconcileSeenResourceAlertIds(seenIds.current, events);
    const now = Date.now();
    const selected = selectNotificationsWithinDailyBudget(
      unseen.filter((event) => !mutedResources.includes(event.resource)),
      sentAtMs.current,
      now,
    );
    if (selected.length === 0) return;
    let disposed = false;
    void Promise.all(selected.map((event) =>
      sendResourceNotification(event, language)
    )).then((results) => {
      if (disposed) return;
      const successfulCount = results.filter(Boolean).length;
      if (successfulCount > 0) {
        sentAtMs.current = [
          ...sentAtMs.current,
          ...Array.from({ length: successfulCount }, () => now),
        ];
        saveDesktopNotificationLog(sentAtMs.current);
      }
      setDelivery({
        kind: "resource",
        status: successfulCount === results.length ? "sent" : "failed",
        attemptedAtMs: Date.now(),
      });
    });
    return () => {
      disposed = true;
    };
  }, [desktop, enabled, events, language, mutedResources, status]);

  const sendTest = async () => {
    if (!enabled || status !== "ready") return false;
    let sent: boolean;
    try {
      sent = await deliverDesktopNotification(
        await desktopNotificationTestCopy(language),
      );
    } catch {
      sent = false;
    }
    setDelivery({
      kind: "test",
      status: sent ? "sent" : "failed",
      attemptedAtMs: Date.now(),
    });
    return sent;
  };

  return { status, delivery, sendTest };
}

function activeTriggeredAlerts(
  events: readonly ResourceAlertEvent[],
): ResourceAlertEvent[] {
  const active = new Map<ResourceAlertResource, ResourceAlertEvent>();
  for (const event of events) {
    if (event.kind === "triggered") active.set(event.resource, event);
    else active.delete(event.resource);
  }
  return [...active.values()];
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

async function isNotificationPermissionGranted() {
  try {
    const { isPermissionGranted } = await import(
      "@tauri-apps/plugin-notification"
    );
    return await isPermissionGranted();
  } catch {
    return false;
  }
}

async function sendResourceNotification(
  event: ResourceAlertEvent,
  language: SupportedLanguage,
): Promise<boolean> {
  try {
    return await deliverDesktopNotification({
      ...(await desktopNotificationCopy(event, language)),
      extra: { coreRobinResource: event.resource },
    });
  } catch {
    return false;
  }
}
