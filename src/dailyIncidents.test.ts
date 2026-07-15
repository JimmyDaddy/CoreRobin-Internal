import { describe, expect, it } from "vitest";

import {
  activeDailyIncidents,
  buildStableDailyOrbitItems,
  createDailyIncidentEvaluationState,
  dailyIncidentLevel,
  evaluateDailyIncidents,
  pendingDailyIncidentCount,
  retainedDailyIncidents,
  type DailyIncidentEvaluationInput,
  type DailyIncidentTiming,
} from "./dailyIncidents";
import type {
  DiagnosisFinding,
  SmartDiagnosisResult,
} from "./diagnosis";
import { getMockSnapshot } from "./mockData";
import type { SystemSnapshot } from "./types";

const timing: DailyIncidentTiming = {
  confirmationMs: 10,
  urgentTemperatureConfirmationMs: 3,
  recoveryMs: 15,
  batteryRecoveryMs: 5,
  resolvedRetentionMs: 100,
};

describe("daily incident lifecycle", () => {
  it("keeps an active incident through a single healthy sample", () => {
    let state = createDailyIncidentEvaluationState();
    const candidateInput = input(100, 80, true);
    state = evaluateDailyIncidents(state, candidateInput, timing);
    expect(activeDailyIncidents(state)).toEqual([]);
    expect(pendingDailyIncidentCount(state)).toBe(1);
    expect(dailyIncidentLevel([], true, 1)).toBe("observing");
    expect(
      buildStableDailyOrbitItems(
        [],
        candidateInput.diagnosis,
        candidateInput.snapshot,
      ).find(({ kind }) => kind === "speed")?.level,
    ).toBe("normal");

    const activeInput = input(110, 82, true);
    state = evaluateDailyIncidents(state, activeInput, timing);
    const active = activeDailyIncidents(state);
    expect(active).toHaveLength(1);
    expect(
      buildStableDailyOrbitItems(
        active,
        activeInput.diagnosis,
        activeInput.snapshot,
      ).find(({ kind }) => kind === "speed")?.level,
    ).toBe("attention");
    const occurrenceId = active[0]?.occurrenceId;

    state = evaluateDailyIncidents(state, input(111, 40, false), timing);
    expect(activeDailyIncidents(state)).toMatchObject([
      { phase: "recovering", occurrenceId },
    ]);
  });

  it("uses a lower recovery threshold as hysteresis", () => {
    let state = createDailyIncidentEvaluationState();
    state = evaluateDailyIncidents(state, input(100, 80, true), timing);
    state = evaluateDailyIncidents(state, input(110, 82, true), timing);

    state = evaluateDailyIncidents(state, input(111, 70, false), timing);
    expect(activeDailyIncidents(state)).toMatchObject([{ phase: "active" }]);

    state = evaluateDailyIncidents(state, input(112, 64, false), timing);
    expect(activeDailyIncidents(state)).toMatchObject([{ phase: "recovering" }]);
  });

  it("requires sustained recovery and cancels recovery when pressure returns", () => {
    let state = createDailyIncidentEvaluationState();
    state = evaluateDailyIncidents(state, input(100, 80, true), timing);
    state = evaluateDailyIncidents(state, input(110, 82, true), timing);
    const occurrenceId = activeDailyIncidents(state)[0]?.occurrenceId;

    state = evaluateDailyIncidents(state, input(120, 40, false), timing);
    state = evaluateDailyIncidents(state, input(130, 83, true), timing);
    expect(activeDailyIncidents(state)).toMatchObject([
      { phase: "active", occurrenceId },
    ]);

    state = evaluateDailyIncidents(state, input(140, 40, false), timing);
    state = evaluateDailyIncidents(state, input(155, 40, false), timing);
    expect(activeDailyIncidents(state)).toEqual([]);
    expect(retainedDailyIncidents(state)).toMatchObject([
      { phase: "resolved", occurrenceId, resolvedAtMs: 155 },
    ]);
  });

  it("does not treat missing data as recovery", () => {
    let state = createDailyIncidentEvaluationState();
    state = evaluateDailyIncidents(state, input(100, 80, true), timing);
    state = evaluateDailyIncidents(state, input(110, 82, true), timing);

    state = evaluateDailyIncidents(state, input(120, null, false), timing);
    expect(activeDailyIncidents(state)).toMatchObject([{ phase: "active" }]);
  });

  it("keeps resolved evidence briefly for an already-open detail", () => {
    let state = createDailyIncidentEvaluationState();
    state = evaluateDailyIncidents(state, input(100, 80, true), timing);
    state = evaluateDailyIncidents(state, input(110, 82, true), timing);
    state = evaluateDailyIncidents(state, input(120, 40, false), timing);
    state = evaluateDailyIncidents(state, input(135, 40, false), timing);
    expect(retainedDailyIncidents(state)).toHaveLength(1);

    state = evaluateDailyIncidents(state, input(236, 40, false), timing);
    expect(retainedDailyIncidents(state)).toEqual([]);
  });
});

function input(
  sampledAtMs: number,
  cpuPercent: number | null,
  includeFinding: boolean,
): DailyIncidentEvaluationInput {
  const snapshot = calmSnapshot(sampledAtMs);
  snapshot.cpu.usagePercent = cpuPercent;
  const findings = includeFinding ? [cpuFinding(cpuPercent ?? 80)] : [];
  return {
    snapshot,
    connections: null,
    diagnosis: diagnosis(sampledAtMs, findings),
  };
}

function calmSnapshot(sampledAtMs: number): SystemSnapshot {
  const snapshot = structuredClone(getMockSnapshot());
  snapshot.sampledAtMs = sampledAtMs;
  snapshot.sampleIntervalMs = 1;
  snapshot.sensors.sampledAtMs = sampledAtMs;
  snapshot.sensors.sleep.sampledAtMs = sampledAtMs;
  snapshot.sensors.sleep.blockers = [];
  snapshot.sensors.temperature.celsius = 55;
  snapshot.sensors.battery = {
    ...snapshot.sensors.battery,
    present: true,
    chargePercent: 80,
    state: "discharging",
  };
  snapshot.disk.volumes = snapshot.disk.volumes.map((volume) => ({
    ...volume,
    availableBytes: Math.max(volume.availableBytes, volume.totalBytes * 0.5),
  }));
  snapshot.disk.readBytesPerSecond = 0;
  snapshot.disk.writeBytesPerSecond = 0;
  snapshot.network.receivedBytesPerSecond = 0;
  snapshot.network.transmittedBytesPerSecond = 0;
  return snapshot;
}

function diagnosis(
  analyzedAtMs: number,
  findings: DiagnosisFinding[],
): SmartDiagnosisResult {
  return {
    analyzedAtMs,
    status: findings.length > 0 ? "attention" : "healthy",
    findings,
    applications: [],
    baselineReady: true,
    sampleSpanMs: 20_000,
    checkedCategories: ["cpu", "memory", "storage", "disk_io", "network"],
  };
}

function cpuFinding(value: number): DiagnosisFinding {
  return {
    id: "sustained_cpu",
    code: "sustained_cpu",
    category: "cpu",
    severity: value >= 90 ? "urgent" : "attention",
    actionTarget: "processes",
    value,
    threshold: 75,
    durationMs: 10_000,
    secondaryValue: null,
    resourceLabel: null,
    culprit: null,
    recommendation: {
      kind: "inspect_process",
      safety: "safe",
      target: "processes",
      processIdentity: null,
      applicationName: null,
    },
  };
}
