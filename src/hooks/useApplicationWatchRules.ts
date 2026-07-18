import { useEffect, useRef, useState } from "react";

import type {
  ApplicationWatchRuleEvent,
  ApplicationWatchRuleState,
} from "../applicationWatchRules";
import { aggregateApplications } from "../diagnosis";
import type { DesktopNotificationStatus } from "../desktopNotifications";
import type { SupportedLanguage } from "../language";
import type { ApplicationWatchRule } from "../settings";
import type { SystemSnapshot } from "../types";

export function useApplicationWatchRules(
  snapshot: SystemSnapshot | null,
  rules: readonly ApplicationWatchRule[],
  notificationsEnabled: boolean,
  notificationStatus: DesktopNotificationStatus,
  language: SupportedLanguage,
) {
  const statesRef = useRef(new Map<string, ApplicationWatchRuleState>());
  const [activeRuleIds, setActiveRuleIds] = useState<string[]>([]);

  useEffect(() => {
    if (!snapshot) return;
    let cancelled = false;
    void import("../applicationWatchRules").then(({ evaluateApplicationWatchRules }) => {
      if (cancelled) return;
      const result = evaluateApplicationWatchRules(
        statesRef.current,
        rules,
        aggregateApplications(snapshot.processes),
        snapshot.sampledAtMs,
      );
      statesRef.current = result.states;
      setActiveRuleIds([...result.states]
        .filter(([, state]) => state.active)
        .map(([id]) => id));
      if (!notificationsEnabled || notificationStatus !== "ready") return;
      for (const event of result.events) void sendWatchRuleNotification(event, language);
    });
    return () => {
      cancelled = true;
    };
  }, [language, notificationStatus, notificationsEnabled, rules, snapshot]);

  return { activeRuleIds };
}

async function sendWatchRuleNotification(
  event: ApplicationWatchRuleEvent,
  language: SupportedLanguage,
) {
  try {
    const { sendNotification } = await import("@tauri-apps/plugin-notification");
    const metric = event.rule.metric === "cpu"
      ? `CPU ${event.value.toFixed(0)}%`
      : event.rule.metric === "memory"
        ? `${event.value.toFixed(0)} MiB memory`
        : `${event.value.toFixed(1)} MiB/s disk`;
    const chinese = language === "zh-CN" || language === "zh-Hant";
    sendNotification({
      title: chinese
        ? `${event.application.name} 达到关注条件`
        : `${event.application.name} reached a watch rule`,
      body: chinese
        ? `${metric} 已持续 ${event.rule.durationSeconds} 秒。`
        : `${metric} persisted for ${event.rule.durationSeconds} seconds.`,
      autoCancel: true,
    });
  } catch {
    // The rule stays active in settings even when the OS rejects a toast.
  }
}
