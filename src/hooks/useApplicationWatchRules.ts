import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { isDesktopRuntime } from "../api";
import {
  deliverDesktopNotification,
  type DesktopNotificationDelivery,
} from "../desktopNotifications";
import {
  type ApplicationWatchRuleEvent,
  type ApplicationWatchRuleState,
} from "../applicationWatchRules";
import {
  clearApplicationWatchHistory,
  createApplicationWatchHistoryEvent,
  loadApplicationWatchHistory,
  mergeApplicationWatchHistory,
  saveApplicationWatchHistory,
  type ApplicationWatchHistoryEvent,
} from "../applicationWatchHistory";
import { aggregateApplications } from "../diagnosis";
import type { DesktopNotificationStatus } from "../desktopNotifications";
import type { HistoryRetentionDays } from "../historyStore";
import { translateNotification } from "../i18n/notificationTranslator";
import type { SupportedLanguage } from "../language";
import type { ApplicationWatchRule } from "../settings";
import type { SystemSnapshot } from "../types";

export function useApplicationWatchRules(
  snapshot: SystemSnapshot | null,
  rules: readonly ApplicationWatchRule[],
  notificationsEnabled: boolean,
  notificationStatus: DesktopNotificationStatus,
  language: SupportedLanguage,
  persistenceEnabled: boolean,
  retentionDays: HistoryRetentionDays,
  applicationNamesEnabled: boolean,
  onOpenEvidence: (applicationName: string) => void,
) {
  const statesRef = useRef(new Map<string, ApplicationWatchRuleState>());
  const [activeRuleIds, setActiveRuleIds] = useState<string[]>([]);
  const [sessionEvents, setSessionEvents] =
    useState<ApplicationWatchHistoryEvent[]>([]);
  const [storedEvents, setStoredEvents] = useState(
    loadApplicationWatchHistory,
  );
  const [notificationDelivery, setNotificationDelivery] =
    useState<DesktopNotificationDelivery | null>(null);

  useEffect(() => {
    if (!snapshot) return;
    let cancelled = false;
    void import("../applicationWatchRules").then(
      ({ evaluateApplicationWatchRules }) => {
        if (cancelled) return;
        const result = evaluateApplicationWatchRules(
          statesRef.current,
          rules,
          aggregateApplications(snapshot.processes),
          snapshot.sampledAtMs,
        );
        statesRef.current = result.states;
        setActiveRuleIds(
          [...result.states]
            .filter(([, state]) => state.active)
            .map(([id]) => id),
        );
        if (result.events.length > 0) {
          const sessionHistoryEvents = result.events.map((event) =>
            createApplicationWatchHistoryEvent(
              event.rule,
              event.kind,
              event.value,
              event.triggeredAtMs,
              true,
            ));
          setSessionEvents((current) =>
            mergeApplicationWatchHistory(
              current,
              sessionHistoryEvents,
              snapshot.sampledAtMs,
              retentionDays,
            ));
          if (persistenceEnabled) {
            setStoredEvents((current) => {
              const persistentEvents = result.events.map((event) =>
                createApplicationWatchHistoryEvent(
                  event.rule,
                  event.kind,
                  event.value,
                  event.triggeredAtMs,
                  applicationNamesEnabled,
                ));
              const next = mergeApplicationWatchHistory(
                current,
                persistentEvents,
                snapshot.sampledAtMs,
                retentionDays,
              );
              saveApplicationWatchHistory(next);
              return next;
            });
          }
        }
        if (!notificationsEnabled || notificationStatus !== "ready") return;
        for (const event of result.events) {
          void sendWatchRuleNotification(event, language).then((sent) => {
            if (cancelled) return;
            setNotificationDelivery({
              kind: "watch",
              status: sent ? "sent" : "failed",
              attemptedAtMs: Date.now(),
            });
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [
    applicationNamesEnabled,
    language,
    notificationStatus,
    notificationsEnabled,
    persistenceEnabled,
    retentionDays,
    rules,
    snapshot,
  ]);

  useEffect(() => {
    setStoredEvents((current) => {
      const next = mergeApplicationWatchHistory(
        current,
        [],
        Date.now(),
        retentionDays,
      );
      saveApplicationWatchHistory(next);
      return next;
    });
  }, [retentionDays]);

  useEffect(() => {
    if (applicationNamesEnabled) return;
    setStoredEvents((current) => {
      const next = current.map((event) => ({
        ...event,
        applicationName: null,
      }));
      saveApplicationWatchHistory(next);
      return next;
    });
  }, [applicationNamesEnabled]);

  useEffect(() => {
    if (!notificationsEnabled || !isDesktopRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/plugin-notification")
      .then(({ onAction }) =>
        onAction((notification) => {
          const applicationName =
            notification.extra?.coreRobinApplicationName;
          if (typeof applicationName === "string" && applicationName) {
            onOpenEvidence(applicationName);
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
  }, [notificationsEnabled, onOpenEvidence]);

  const events = useMemo(
    () =>
      mergeApplicationWatchHistory(
        storedEvents,
        sessionEvents,
        Date.now(),
        retentionDays,
      ),
    [retentionDays, sessionEvents, storedEvents],
  );

  const clearSaved = useCallback(() => {
    clearApplicationWatchHistory();
    setStoredEvents([]);
  }, []);

  return {
    activeRuleIds,
    events,
    storedEvents,
    clearSaved,
    notificationDelivery,
  };
}

async function sendWatchRuleNotification(
  event: ApplicationWatchRuleEvent,
  language: SupportedLanguage,
): Promise<boolean> {
  try {
    const applicationName =
      event.application?.name ?? event.rule.applicationName;
    const value = event.rule.metric === "disk"
      ? event.value.toFixed(1)
      : event.value.toFixed(0);
    const metric = await translateNotification(
      language,
      `watch.metric.${event.rule.metric}`,
      { value },
    );
    return await deliverDesktopNotification({
      title: await translateNotification(
        language,
        `watch.${event.kind}.title`,
        { application: applicationName },
      ),
      body: await translateNotification(
        language,
        `watch.${event.kind}.body`,
        {
          metric,
          seconds: event.rule.durationSeconds,
        },
      ),
      extra: {
        coreRobinWatchRuleId: event.rule.id,
        coreRobinApplicationName: applicationName,
      },
    });
  } catch {
    return false;
  }
}
