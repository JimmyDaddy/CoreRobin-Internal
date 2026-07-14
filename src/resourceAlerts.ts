import type { UsageThresholds } from "./settings";

export const ALERT_BREACH_DURATION_MS = 10_000;
export const ALERT_RECOVERY_DURATION_MS = 15_000;
export const ALERT_COOLDOWN_MS = 60_000;
export const ALERT_RECOVERY_HYSTERESIS_PERCENT = 5;

export const RESOURCE_ALERT_RESOURCES = ["cpu", "memory", "volume"] as const;

export type ResourceAlertResource = (typeof RESOURCE_ALERT_RESOURCES)[number];
export type ResourceAlertKind = "triggered" | "recovered";
export type ResourceAlertSeverity = "high" | "critical";

export interface ResourceAlertEvent {
  id: string;
  timestamp: number;
  resource: ResourceAlertResource;
  kind: ResourceAlertKind;
  severity: ResourceAlertSeverity;
  valuePercent: number;
  thresholdPercent: number;
  startedAtMs: number;
  durationMs: number;
}

export interface ResourceAlertSample {
  resource: ResourceAlertResource;
  valuePercent: number | null;
}

interface ResourceAlertTracker {
  breachSinceMs: number | null;
  recoverySinceMs: number | null;
  activeSinceMs: number | null;
  activeSeverity: ResourceAlertSeverity | null;
  cooldownUntilMs: number;
  lastValuePercent: number | null;
}

export interface ResourceAlertEvaluationState {
  trackers: Record<ResourceAlertResource, ResourceAlertTracker>;
}

export interface ActiveResourceAlert {
  resource: ResourceAlertResource;
  severity: ResourceAlertSeverity;
  startedAtMs: number;
  valuePercent: number;
}

interface ResourceAlertTiming {
  breachDurationMs: number;
  recoveryDurationMs: number;
  cooldownMs: number;
  recoveryHysteresisPercent: number;
}

const DEFAULT_TIMING: ResourceAlertTiming = {
  breachDurationMs: ALERT_BREACH_DURATION_MS,
  recoveryDurationMs: ALERT_RECOVERY_DURATION_MS,
  cooldownMs: ALERT_COOLDOWN_MS,
  recoveryHysteresisPercent: ALERT_RECOVERY_HYSTERESIS_PERCENT,
};

export function createResourceAlertEvaluationState(): ResourceAlertEvaluationState {
  return {
    trackers: {
      cpu: createTracker(),
      memory: createTracker(),
      volume: createTracker(),
    },
  };
}

export function evaluateResourceAlerts(
  current: ResourceAlertEvaluationState,
  samples: readonly ResourceAlertSample[],
  sampledAtMs: number,
  thresholds: UsageThresholds,
  timing: Partial<ResourceAlertTiming> = {},
): { state: ResourceAlertEvaluationState; events: ResourceAlertEvent[] } {
  const options = { ...DEFAULT_TIMING, ...timing };
  const alertThreshold = thresholds[1];
  const criticalThreshold = thresholds[2];
  const recoveryThreshold = Math.max(
    0,
    alertThreshold - options.recoveryHysteresisPercent,
  );
  const trackers = { ...current.trackers };
  const events: ResourceAlertEvent[] = [];

  for (const sample of samples) {
    if (
      sample.valuePercent === null ||
      !Number.isFinite(sample.valuePercent) ||
      sample.valuePercent < 0
    ) {
      continue;
    }

    const valuePercent = Math.min(100, sample.valuePercent);
    const tracker = { ...trackers[sample.resource], lastValuePercent: valuePercent };

    if (valuePercent >= alertThreshold) {
      tracker.recoverySinceMs = null;
      if (tracker.activeSinceMs !== null) {
        if (valuePercent >= criticalThreshold) {
          tracker.activeSeverity = "critical";
        }
      } else {
        tracker.breachSinceMs ??= sampledAtMs;
        const sustained = sampledAtMs - tracker.breachSinceMs >= options.breachDurationMs;
        if (sustained && sampledAtMs >= tracker.cooldownUntilMs) {
          tracker.activeSinceMs = tracker.breachSinceMs;
          tracker.activeSeverity = severityFor(valuePercent, criticalThreshold);
          events.push(
            alertEvent(
              sample.resource,
              "triggered",
              tracker.activeSeverity,
              valuePercent,
              alertThreshold,
              tracker.activeSinceMs,
              sampledAtMs,
            ),
          );
        }
      }
    } else if (valuePercent < recoveryThreshold) {
      tracker.breachSinceMs = null;
      if (tracker.activeSinceMs !== null && tracker.activeSeverity !== null) {
        tracker.recoverySinceMs ??= sampledAtMs;
        if (sampledAtMs - tracker.recoverySinceMs >= options.recoveryDurationMs) {
          events.push(
            alertEvent(
              sample.resource,
              "recovered",
              tracker.activeSeverity,
              valuePercent,
              alertThreshold,
              tracker.activeSinceMs,
              sampledAtMs,
            ),
          );
          tracker.activeSinceMs = null;
          tracker.activeSeverity = null;
          tracker.recoverySinceMs = null;
          tracker.cooldownUntilMs = sampledAtMs + options.cooldownMs;
        }
      }
    } else {
      tracker.breachSinceMs = null;
      tracker.recoverySinceMs = null;
    }

    trackers[sample.resource] = tracker;
  }

  return { state: { trackers }, events };
}

export function activeResourceAlerts(
  state: ResourceAlertEvaluationState,
): ActiveResourceAlert[] {
  return RESOURCE_ALERT_RESOURCES.flatMap((resource) => {
    const tracker = state.trackers[resource];
    return tracker.activeSinceMs !== null &&
      tracker.activeSeverity !== null &&
      tracker.lastValuePercent !== null
      ? [{
          resource,
          severity: tracker.activeSeverity,
          startedAtMs: tracker.activeSinceMs,
          valuePercent: tracker.lastValuePercent,
        }]
      : [];
  });
}

function createTracker(): ResourceAlertTracker {
  return {
    breachSinceMs: null,
    recoverySinceMs: null,
    activeSinceMs: null,
    activeSeverity: null,
    cooldownUntilMs: 0,
    lastValuePercent: null,
  };
}

function severityFor(
  valuePercent: number,
  criticalThreshold: number,
): ResourceAlertSeverity {
  return valuePercent >= criticalThreshold ? "critical" : "high";
}

function alertEvent(
  resource: ResourceAlertResource,
  kind: ResourceAlertKind,
  severity: ResourceAlertSeverity,
  valuePercent: number,
  thresholdPercent: number,
  startedAtMs: number,
  timestamp: number,
): ResourceAlertEvent {
  return {
    id: `${resource}:${kind}:${timestamp}`,
    timestamp,
    resource,
    kind,
    severity,
    valuePercent,
    thresholdPercent,
    startedAtMs,
    durationMs: Math.max(0, timestamp - startedAtMs),
  };
}
