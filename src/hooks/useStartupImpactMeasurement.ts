import { useEffect, useState } from "react";

import { getStartupContext, getSystemSnapshot } from "../api";
import { aggregateApplications } from "../diagnosis";
import type { StartupImpactMeasurement } from "../startupImpact";

const SAMPLE_INTERVAL_MS = 5_000;
const CONTEXT_FRESHNESS_MS = 2 * 60 * 1_000;

export function useStartupImpactMeasurement(): StartupImpactMeasurement[] {
  const [measurements, setMeasurements] = useState<StartupImpactMeasurement[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    void Promise.all([
      getStartupContext(),
      import("../startupImpact"),
    ]).then(([context, startupImpact]) => {
      const existing = startupImpact.loadStartupImpactMeasurements(window.localStorage);
      if (!cancelled) setMeasurements(existing);
      if (cancelled || !context.backgroundLaunch) return;
      if (Date.now() - context.launchedAtMs > CONTEXT_FRESHNESS_MS) return;
      if (existing
        .some((measurement) => measurement.launchedAtMs === context.launchedAtMs)) return;

      const accumulator = startupImpact.createStartupImpactAccumulator(context.launchedAtMs);
      const sample = async () => {
        try {
          const snapshot = await getSystemSnapshot();
          if (cancelled) return;
          const diskRate = Math.max(0, snapshot.disk.readBytesPerSecond ?? 0) +
            Math.max(0, snapshot.disk.writeBytesPerSecond ?? 0);
          const state = startupImpact.addStartupImpactSample(
            accumulator,
            snapshot.sampledAtMs,
            Math.max(0, snapshot.cpu.usagePercent ?? 0),
            diskRate,
            aggregateApplications(snapshot.processes),
          );
          if (state.settled || state.expired) {
            const measurement = startupImpact.completeStartupImpactMeasurement(
              accumulator,
              snapshot.sampledAtMs,
              state.settled,
            );
            setMeasurements(startupImpact.saveStartupImpactMeasurement(window.localStorage, measurement));
            return;
          }
        } catch {
          // A later sample can still complete the measurement.
        }
        if (!cancelled) timer = window.setTimeout(() => void sample(), SAMPLE_INTERVAL_MS);
      };
      void sample();
    }).catch(() => undefined);

    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  return measurements;
}
