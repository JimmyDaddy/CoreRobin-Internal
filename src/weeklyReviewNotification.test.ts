import { describe, expect, it } from "vitest";

import {
  loadWeeklyReviewNotificationState,
  markWeeklyReviewNotificationSent,
  nextWeeklyReviewAt,
  weeklyReviewNotificationDue,
} from "./weeklyReviewNotification";

describe("weekly review notification schedule", () => {
  it("schedules the next Monday at 09:00 local time", () => {
    const friday = new Date(2026, 6, 31, 12).getTime();
    const due = new Date(nextWeeklyReviewAt(friday));
    expect(due.getDay()).toBe(1);
    expect(due.getHours()).toBe(9);
  });

  it("sends once and advances to a future week", () => {
    const now = new Date(2026, 7, 3, 10).getTime();
    const initial = {
      version: 1 as const,
      nextDueAtMs: now - 1,
      lastSentAtMs: null,
    };
    expect(weeklyReviewNotificationDue(initial, now)).toBe(true);
    const sent = markWeeklyReviewNotificationSent(initial, now);
    expect(sent.lastSentAtMs).toBe(now);
    expect(sent.nextDueAtMs).toBeGreaterThan(now);
  });

  it("repairs an invalid local schedule", () => {
    const now = Date.now();
    const state = loadWeeklyReviewNotificationState(now, {
      getItem: () => "{bad",
    });
    expect(state.nextDueAtMs).toBeGreaterThan(now);
  });
});
