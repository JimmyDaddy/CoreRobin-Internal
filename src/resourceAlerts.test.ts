import { describe, expect, it } from "vitest";

import {
  activeResourceAlerts,
  createResourceAlertEvaluationState,
  evaluateResourceAlerts,
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
      },
    ]);
    expect(activeResourceAlerts(result.state)).toEqual([]);
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
});
