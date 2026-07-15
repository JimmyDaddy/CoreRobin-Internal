import { describe, expect, it } from "vitest";

import {
  desktopNotificationCopy,
  selectNotificationsWithinDailyBudget,
  shouldSendDesktopNotification,
} from "./desktopNotifications";
import type { ResourceAlertEvent } from "./resourceAlerts";

function event(update: Partial<ResourceAlertEvent> = {}): ResourceAlertEvent {
  return {
    id: "cpu:triggered:110",
    timestamp: 110,
    resource: "cpu",
    kind: "triggered",
    severity: "critical",
    valuePercent: 92,
    thresholdPercent: 65,
    startedAtMs: 100,
    durationMs: 10,
    ...update,
  };
}

describe("desktop notifications", () => {
  it("only interrupts for sustained actionable events", () => {
    expect(shouldSendDesktopNotification(event())).toBe(true);
    expect(shouldSendDesktopNotification(event({ severity: "high" }))).toBe(false);
    expect(shouldSendDesktopNotification(event({ kind: "recovered" }))).toBe(true);
    expect(shouldSendDesktopNotification(event({ kind: "recovered", severity: "high" }))).toBe(false);
    expect(shouldSendDesktopNotification(event({ resource: "memory", severity: "high" }))).toBe(true);
    expect(shouldSendDesktopNotification(event({ resource: "volume", severity: "high" }))).toBe(true);
  });

  it("uses plain-language localized copy", async () => {
    expect((await desktopNotificationCopy(event({ resource: "volume" }), "zh-CN")).body).toContain("空间地图");
    expect((await desktopNotificationCopy(event({ resource: "memory" }), "en")).body).toContain("swap");
    expect((await desktopNotificationCopy(event({ kind: "recovered", resource: "cpu" }), "zh-CN")).title).toContain("恢复");
    expect((await desktopNotificationCopy(event({ kind: "recovered", resource: "volume" }), "en")).body).toContain("safe range");
  });

  it("caps interruptions per local day after applying actionability rules", () => {
    const now = new Date(2026, 6, 14, 12).getTime();
    const events = [0, 1, 2].map((index) => event({ id: `cpu:${index}` }));
    expect(selectNotificationsWithinDailyBudget(events, [now - 1_000, now - 2_000], now, 4)).toHaveLength(2);
    expect(selectNotificationsWithinDailyBudget(events, [now - 86_400_000], now, 4)).toHaveLength(3);
  });
});
