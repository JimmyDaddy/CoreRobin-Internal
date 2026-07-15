import { describe, expect, it } from "vitest";

import type { DailyIncident } from "./dailyIncidents";
import {
  buildHealthStateUpdate,
  selectNewerHealthState,
  type HealthStateSnapshot,
} from "./healthState";
import { getMockSnapshot } from "./mockData";

describe("shared health state", () => {
  it("projects the stable incident count and recovery phase for every surface", () => {
    const snapshot = getMockSnapshot();
    const incident = batteryIncident("recovering");

    const state = buildHealthStateUpdate(
      snapshot,
      false,
      [incident],
      2,
      true,
      "background",
    );

    expect(state).toMatchObject({
      schemaVersion: 1,
      dataMode: "background",
      health: "attention",
      reason: "battery",
      activeCount: 1,
      pendingCount: 2,
      recoveringCount: 1,
      primaryIncident: {
        occurrenceId: incident.occurrenceId,
        phase: "recovering",
        intent: "heat",
      },
    });
  });

  it("keeps the public status observing while candidates are unconfirmed", () => {
    const state = buildHealthStateUpdate(
      getMockSnapshot(),
      false,
      [],
      1,
      true,
      "foreground",
    );

    expect(state.health).toBe("observing");
    expect(state.activeCount).toBe(0);
    expect(state.primaryIncident).toBeNull();
  });

  it("ignores an older retained snapshot after a newer event arrives", () => {
    const newer = snapshotWithRevision(3);
    const older = snapshotWithRevision(2);

    expect(selectNewerHealthState(newer, older)).toBe(newer);
    expect(selectNewerHealthState(older, newer)).toBe(newer);
  });
});

function batteryIncident(phase: DailyIncident["phase"]): DailyIncident {
  const item: DailyIncident["item"] = {
    id: "wellbeing:battery",
    kind: "battery",
    level: "urgent",
    intent: "heat",
    chargePercent: 8,
  };
  return {
    id: item.id,
    occurrenceId: `${item.id}:100`,
    phase,
    item,
    peakItem: item,
    firstObservedAtMs: 100,
    activatedAtMs: 100,
    lastObservedAtMs: 110,
    recoveryStartedAtMs: phase === "recovering" ? 110 : null,
    resolvedAtMs: phase === "resolved" ? 120 : null,
  };
}

function snapshotWithRevision(revision: number): HealthStateSnapshot {
  return {
    ...buildHealthStateUpdate(
      getMockSnapshot(),
      false,
      [],
      0,
      true,
      "foreground",
    ),
    revision,
  };
}
