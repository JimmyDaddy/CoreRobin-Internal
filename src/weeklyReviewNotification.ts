export const WEEKLY_REVIEW_NOTIFICATION_STORAGE_KEY =
  "core-robin.weekly-review-notification.v1";

interface WeeklyReviewNotificationState {
  version: 1;
  nextDueAtMs: number;
  lastSentAtMs: number | null;
}

export function loadWeeklyReviewNotificationState(
  now = Date.now(),
  storage: Pick<Storage, "getItem"> = window.localStorage,
): WeeklyReviewNotificationState {
  try {
    const value = JSON.parse(
      storage.getItem(WEEKLY_REVIEW_NOTIFICATION_STORAGE_KEY) ?? "null",
    ) as unknown;
    if (
      isRecord(value)
      && value.version === 1
      && isTimestamp(value.nextDueAtMs)
      && (value.lastSentAtMs === null || isTimestamp(value.lastSentAtMs))
    ) {
      return value as unknown as WeeklyReviewNotificationState;
    }
  } catch {
    // A new local schedule is safer than surfacing corrupted preference data.
  }
  return {
    version: 1,
    nextDueAtMs: nextWeeklyReviewAt(now),
    lastSentAtMs: null,
  };
}

export function saveWeeklyReviewNotificationState(
  state: WeeklyReviewNotificationState,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  try {
    storage.setItem(
      WEEKLY_REVIEW_NOTIFICATION_STORAGE_KEY,
      JSON.stringify(state),
    );
  } catch {
    // The session-level guard in the hook still avoids repeated notifications.
  }
}

export function weeklyReviewNotificationDue(
  state: WeeklyReviewNotificationState,
  now = Date.now(),
): boolean {
  return now >= state.nextDueAtMs;
}

export function markWeeklyReviewNotificationSent(
  state: WeeklyReviewNotificationState,
  now = Date.now(),
): WeeklyReviewNotificationState {
  return {
    ...state,
    lastSentAtMs: now,
    nextDueAtMs: nextWeeklyReviewAt(now),
  };
}

export function nextWeeklyReviewAt(now: number): number {
  const next = new Date(now);
  next.setHours(9, 0, 0, 0);
  const daysUntilMonday = (8 - next.getDay()) % 7 || 7;
  next.setDate(next.getDate() + daysUntilMonday);
  return next.getTime();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
