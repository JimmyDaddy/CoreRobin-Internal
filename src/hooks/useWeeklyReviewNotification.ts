import { useEffect, useRef } from "react";

import {
  deliverDesktopNotification,
  type DesktopNotificationStatus,
} from "../desktopNotifications";
import {
  loadWeeklyReviewNotificationState,
  markWeeklyReviewNotificationSent,
  saveWeeklyReviewNotificationState,
  weeklyReviewNotificationDue,
} from "../weeklyReviewNotification";

export function useWeeklyReviewNotification({
  enabled,
  notificationStatus,
  title,
  body,
}: {
  enabled: boolean;
  notificationStatus: DesktopNotificationStatus;
  title: string;
  body: string;
}): void {
  const delivering = useRef(false);
  useEffect(() => {
    if (!enabled || notificationStatus !== "ready" || delivering.current) return;
    const state = loadWeeklyReviewNotificationState();
    if (!weeklyReviewNotificationDue(state)) {
      saveWeeklyReviewNotificationState(state);
      return;
    }
    delivering.current = true;
    void deliverDesktopNotification({ title, body })
      .then((sent) => {
        if (sent) {
          saveWeeklyReviewNotificationState(
            markWeeklyReviewNotificationSent(state),
          );
        }
      })
      .finally(() => {
        delivering.current = false;
      });
  }, [body, enabled, notificationStatus, title]);
}
