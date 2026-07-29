import { useEffect, useRef } from "react";

import { getStartupContext, isDesktopRuntime } from "../api";
import { aggregateApplications } from "../diagnosis";
import {
  STARTUP_MEASUREMENT_MAX_MS,
  addStartupImpactSample,
  completeStartupImpactMeasurement,
  createStartupImpactAccumulator,
  loadStartupImpactMeasurements,
  mergeStartupImpactMeasurement,
  parseStartupImpactMeasurements,
  saveStartupImpactMeasurement,
  serializeStartupImpactMeasurements,
  STARTUP_IMPACT_STORAGE_KEY,
  type StartupImpactAccumulator,
  type StartupImpactMeasurement,
} from "../startupImpact";
import type { SystemSnapshot } from "../types";
import { useNativeHistoryStorage } from "./useNativeHistoryStorage";

const SAMPLE_INTERVAL_MS = 5_000;
const CONTEXT_FRESHNESS_MS = 2 * 60 * 1_000;

interface ActiveMeasurement {
  accumulator: StartupImpactAccumulator;
  lastSampledAtMs: number;
}

export function useStartupImpactMeasurement(
  snapshot: SystemSnapshot | null,
): StartupImpactMeasurement[] {
  const desktop = isDesktopRuntime();
  const storage = useNativeHistoryStorage<StartupImpactMeasurement[]>({
    category: "startup-impact",
    enabled: true,
    initialValue: () => loadStartupImpactMeasurements(window.localStorage),
    parse: parseStartupImpactMeasurements,
    serialize: serializeStartupImpactMeasurements,
    clearLegacy: () => {
      try {
        window.localStorage.removeItem(STARTUP_IMPACT_STORAGE_KEY);
      } catch {
        // The native history remains the source of truth.
      }
    },
  });
  const measurements = storage.value;
  const setMeasurements = storage.setValue;
  const measurementsRef = useRef(measurements);
  measurementsRef.current = measurements;
  const activeRef = useRef<ActiveMeasurement | null>(null);
  const deadlineTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!storage.hydrated) return;
    let cancelled = false;
    void getStartupContext().then((context) => {
      if (cancelled || !context.backgroundLaunch) return;
      const existing = measurementsRef.current;
      if (existing.some((measurement) =>
        measurement.launchedAtMs === context.launchedAtMs)) return;
      if (Date.now() - context.launchedAtMs > CONTEXT_FRESHNESS_MS) return;
      activeRef.current = {
        accumulator: createStartupImpactAccumulator(context.launchedAtMs),
        lastSampledAtMs: 0,
      };
      deadlineTimerRef.current = window.setTimeout(() => {
        const active = activeRef.current;
        if (!active) return;
        const measurement = completeStartupImpactMeasurement(
          active.accumulator,
          Date.now(),
          false,
        );
        activeRef.current = null;
        setMeasurements((current) => {
          const next = mergeStartupImpactMeasurement(current, measurement);
          if (!desktop) {
            saveStartupImpactMeasurement(window.localStorage, measurement);
          }
          return next;
        });
      }, Math.max(
        0,
        context.launchedAtMs + STARTUP_MEASUREMENT_MAX_MS - Date.now(),
      ));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      if (deadlineTimerRef.current !== null) {
        window.clearTimeout(deadlineTimerRef.current);
      }
    };
  }, [desktop, storage.hydrated]);

  useEffect(() => {
    const active = activeRef.current;
    if (!snapshot || !active) return;
    if (
      active.lastSampledAtMs > 0
      && snapshot.sampledAtMs - active.lastSampledAtMs < SAMPLE_INTERVAL_MS
    ) return;
    active.lastSampledAtMs = snapshot.sampledAtMs;
    const diskRate = Math.max(0, snapshot.disk.readBytesPerSecond ?? 0)
      + Math.max(0, snapshot.disk.writeBytesPerSecond ?? 0);
    const state = addStartupImpactSample(
      active.accumulator,
      snapshot.sampledAtMs,
      Math.max(0, snapshot.cpu.usagePercent ?? 0),
      diskRate,
      aggregateApplications(snapshot.processes),
    );
    const wallClockExpired =
      Date.now() - active.accumulator.launchedAtMs >= STARTUP_MEASUREMENT_MAX_MS;
    if (!state.settled && !state.expired && !wallClockExpired) return;
    const measurement = completeStartupImpactMeasurement(
      active.accumulator,
      Math.max(snapshot.sampledAtMs, Date.now()),
      state.settled,
    );
    activeRef.current = null;
    if (deadlineTimerRef.current !== null) {
      window.clearTimeout(deadlineTimerRef.current);
      deadlineTimerRef.current = null;
    }
    setMeasurements((current) => {
      const next = mergeStartupImpactMeasurement(current, measurement);
      if (!desktop) {
        saveStartupImpactMeasurement(window.localStorage, measurement);
      }
      return next;
    });
  }, [snapshot?.sequence]);

  return measurements;
}
