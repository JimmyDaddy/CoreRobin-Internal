import { describe, expect, it } from "vitest";

import { MAX_RESOURCE_ALERT_EVENTS } from "./alertStore";
import {
  createSeenResourceAlertIds,
  reconcileSeenResourceAlertIds,
} from "./desktopNotificationSeenIds";
import type { ResourceAlertEvent } from "./resourceAlerts";

describe("desktop notification seen IDs", () => {
  it("keeps the set bounded to the retained 5,000 alert events", () => {
    const events = Array.from(
      { length: MAX_RESOURCE_ALERT_EVENTS + 1_000 },
      (_, index) => event(index + 1),
    );
    const seenIds = new Set<string>();

    expect(reconcileSeenResourceAlertIds(seenIds, events)).toHaveLength(
      MAX_RESOURCE_ALERT_EVENTS,
    );
    expect(seenIds.size).toBe(MAX_RESOURCE_ALERT_EVENTS);
    expect(seenIds.has("alert-1")).toBe(false);
    expect(seenIds.has(`alert-${events.length}`)).toBe(true);
    expect(reconcileSeenResourceAlertIds(seenIds, events)).toEqual([]);
  });

  it("drops evicted IDs and reports only newly retained events", () => {
    const initial = Array.from(
      { length: MAX_RESOURCE_ALERT_EVENTS },
      (_, index) => event(index + 1),
    );
    const seenIds = createSeenResourceAlertIds(initial);
    const next = [...initial, event(MAX_RESOURCE_ALERT_EVENTS + 1)];

    expect(reconcileSeenResourceAlertIds(seenIds, next).map(({ id }) => id)).toEqual([
      `alert-${MAX_RESOURCE_ALERT_EVENTS + 1}`,
    ]);
    expect(seenIds.size).toBe(MAX_RESOURCE_ALERT_EVENTS);
    expect(seenIds.has("alert-1")).toBe(false);
  });
});

function event(timestamp: number): ResourceAlertEvent {
  return {
    id: `alert-${timestamp}`,
    timestamp,
    resource: "cpu",
    kind: "triggered",
    severity: "high",
    valuePercent: 75,
    thresholdPercent: 65,
    startedAtMs: timestamp,
    durationMs: 0,
  };
}
