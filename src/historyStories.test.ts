import { describe, expect, it } from "vitest";

import { buildHistoryStories } from "./historyStories";
import type { ResourceAlertEvent } from "./resourceAlerts";

function event(
  resource: ResourceAlertEvent["resource"],
  kind: ResourceAlertEvent["kind"],
  timestamp: number,
  startedAtMs = 100,
  update: Partial<ResourceAlertEvent> = {},
): ResourceAlertEvent {
  return {
    id: `${resource}:${kind}:${timestamp}`,
    timestamp,
    resource,
    kind,
    severity: "high",
    valuePercent: kind === "triggered" ? 76 : 45,
    thresholdPercent: 65,
    startedAtMs,
    durationMs: timestamp - startedAtMs,
    ...update,
  };
}

describe("history stories", () => {
  it("pairs trigger and recovery into one readable incident", () => {
    expect(buildHistoryStories([
      event("cpu", "triggered", 110, 100, {
        culpritName: "Docker Desktop",
        peakValuePercent: 82,
        peakAtMs: 108,
      }),
      event("cpu", "recovered", 180, 100, {
        culpritName: "Docker Desktop",
        peakValuePercent: 94,
        peakAtMs: 132,
      }),
    ])).toMatchObject([{
      resource: "cpu",
      status: "recovered",
      startedAtMs: 100,
      endedAtMs: 180,
      durationMs: 80,
      peakPercent: 94,
      peakAtMs: 132,
      culpritName: "Docker Desktop",
    }]);
  });

  it("keeps unresolved incidents active and sorts newest first", () => {
    const stories = buildHistoryStories([
      event("cpu", "triggered", 110),
      event("volume", "triggered", 310, 300),
    ]);
    expect(stories.map((story) => [story.resource, story.status])).toEqual([
      ["volume", "active"],
      ["cpu", "active"],
    ]);
  });

  it("retains a recovery even when the trigger fell outside retention", () => {
    expect(buildHistoryStories([event("memory", "recovered", 220)])).toMatchObject([
      { resource: "memory", status: "recovered", endedAtMs: 220 },
    ]);
  });
});
