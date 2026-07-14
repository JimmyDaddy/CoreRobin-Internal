import { describe, expect, it } from "vitest";

import {
  activeResourceAlerts,
  createResourceAlertEvaluationState,
  evaluateResourceAlerts,
  memoryPressureAlertPercent,
  type ResourceAlertSample,
} from "./resourceAlerts";

const thresholds = [35, 65, 85] as const;
const timing = {
  breachDurationMs: 10,
  recoveryDurationMs: 15,
  cooldownMs: 60,
  recoveryHysteresisPercent: 5,
};

function cpu(valuePercent: number | null): ResourceAlertSample[] {
  return [{ resource: "cpu", valuePercent }];
}

describe("resource alert evaluation", () => {
  it("does not treat healthy cache-heavy memory use as pressure", () => {
    expect(memoryPressureAlertPercent({
      totalBytes: 16 * 1_024 ** 3,
      usedBytes: 14.8 * 1_024 ** 3,
      availableBytes: 1.2 * 1_024 ** 3,
      swapTotalBytes: 4 * 1_024 ** 3,
      swapUsedBytes: 120 * 1_024 ** 2,
    })).toBe(0);
  });

  it("signals memory pressure only with scarce availability and meaningful swap", () => {
    expect(memoryPressureAlertPercent({
      totalBytes: 16 * 1_024 ** 3,
      usedBytes: 15.2 * 1_024 ** 3,
      availableBytes: 0.8 * 1_024 ** 3,
      swapTotalBytes: 4 * 1_024 ** 3,
      swapUsedBytes: 1.2 * 1_024 ** 3,
    })).toBeCloseTo(95);
  });

  it("requires a sustained high reading before triggering", () => {
    let state = createResourceAlertEvaluationState();
    let result = evaluateResourceAlerts(state, cpu(70), 100, thresholds, timing);
    state = result.state;
    expect(result.events).toEqual([]);

    result = evaluateResourceAlerts(state, cpu(72), 109, thresholds, timing);
    state = result.state;
    expect(result.events).toEqual([]);

    result = evaluateResourceAlerts(state, cpu(88), 110, thresholds, timing);
    expect(result.events).toMatchObject([
      {
        resource: "cpu",
        kind: "triggered",
        severity: "critical",
        valuePercent: 88,
        thresholdPercent: 65,
        startedAtMs: 100,
        durationMs: 10,
      },
    ]);
    expect(activeResourceAlerts(result.state)).toMatchObject([
      { resource: "cpu", severity: "critical", startedAtMs: 100 },
    ]);
  });

  it("drops a short spike without creating an event", () => {
    let state = createResourceAlertEvaluationState();
    state = evaluateResourceAlerts(state, cpu(70), 100, thresholds, timing).state;
    const result = evaluateResourceAlerts(state, cpu(50), 105, thresholds, timing);

    expect(result.events).toEqual([]);
    expect(activeResourceAlerts(result.state)).toEqual([]);
  });

  it("uses hysteresis and a sustained recovery before resolving", () => {
    let state = createResourceAlertEvaluationState();
    state = evaluateResourceAlerts(state, cpu(70), 100, thresholds, timing).state;
    state = evaluateResourceAlerts(state, cpu(70), 110, thresholds, timing).state;

    state = evaluateResourceAlerts(state, cpu(62), 120, thresholds, timing).state;
    expect(activeResourceAlerts(state)).toHaveLength(1);

    state = evaluateResourceAlerts(state, cpu(55), 130, thresholds, timing).state;
    const result = evaluateResourceAlerts(state, cpu(50), 145, thresholds, timing);
    expect(result.events).toMatchObject([
      {
        resource: "cpu",
        kind: "recovered",
        severity: "high",
        valuePercent: 50,
        startedAtMs: 100,
        durationMs: 45,
        peakValuePercent: 70,
        peakAtMs: 110,
      },
    ]);
    expect(activeResourceAlerts(result.state)).toEqual([]);
  });

  it("retains the real peak and its time until the incident recovers", () => {
    let state = createResourceAlertEvaluationState();
    state = evaluateResourceAlerts(state, cpu(70), 100, thresholds, timing).state;
    state = evaluateResourceAlerts(state, cpu(70), 110, thresholds, timing).state;
    state = evaluateResourceAlerts(state, cpu(92), 115, thresholds, timing).state;
    state = evaluateResourceAlerts(state, cpu(50), 120, thresholds, timing).state;
    const result = evaluateResourceAlerts(state, cpu(48), 135, thresholds, timing);

    expect(result.events).toMatchObject([{
      resource: "cpu",
      kind: "recovered",
      peakValuePercent: 92,
      peakAtMs: 115,
    }]);
  });

  it("suppresses a retrigger until the cooldown expires", () => {
    let state = createResourceAlertEvaluationState();
    state = evaluateResourceAlerts(state, cpu(70), 100, thresholds, timing).state;
    state = evaluateResourceAlerts(state, cpu(70), 110, thresholds, timing).state;
    state = evaluateResourceAlerts(state, cpu(50), 120, thresholds, timing).state;
    state = evaluateResourceAlerts(state, cpu(50), 135, thresholds, timing).state;

    state = evaluateResourceAlerts(state, cpu(75), 140, thresholds, timing).state;
    let result = evaluateResourceAlerts(state, cpu(75), 170, thresholds, timing);
    state = result.state;
    expect(result.events).toEqual([]);

    result = evaluateResourceAlerts(state, cpu(75), 195, thresholds, timing);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.kind).toBe("triggered");
  });

  it("evaluates CPU, memory, and aggregate volume samples independently", () => {
    let state = createResourceAlertEvaluationState();
    const samples: ResourceAlertSample[] = [
      { resource: "cpu", valuePercent: 70 },
      { resource: "memory", valuePercent: 90 },
      { resource: "volume", valuePercent: 80 },
    ];
    state = evaluateResourceAlerts(state, samples, 100, thresholds, timing).state;
    const result = evaluateResourceAlerts(state, samples, 110, thresholds, timing);

    expect(result.events.map((event) => [event.resource, event.severity])).toEqual([
      ["cpu", "high"],
      ["memory", "critical"],
      ["volume", "high"],
    ]);
  });

  it("supports safer resource-specific thresholds", () => {
    let state = createResourceAlertEvaluationState();
    const samples: ResourceAlertSample[] = [{
      resource: "volume",
      valuePercent: 87,
      alertThresholdPercent: 85,
      criticalThresholdPercent: 95,
    }];
    state = evaluateResourceAlerts(state, samples, 100, thresholds, timing).state;
    const result = evaluateResourceAlerts(state, samples, 110, thresholds, timing);
    expect(result.events).toMatchObject([{
      resource: "volume",
      severity: "high",
      thresholdPercent: 85,
    }]);
  });
});
