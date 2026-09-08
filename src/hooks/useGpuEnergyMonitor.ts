import { useCallback, useEffect, useRef, useState } from "react";
import { getGpuEnergySnapshot } from "../api";
import type { GpuEnergySnapshot } from "../types";
import { normalizeCommandError } from "../utils";

/** App-owned, on-demand state shared with the operation card. No recording is enabled. */
export function useGpuEnergyMonitor() {
  const [snapshot, setSnapshot] = useState<GpuEnergySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);
  const inFlight = useRef<Promise<void> | null>(null);
  useEffect(() => () => { ++epoch.current; }, []);
  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const generation = epoch.current;
    setLoading(true);
    const pending: Promise<void> = (async () => {
      await Promise.resolve();
      try {
        const result = await getGpuEnergySnapshot();
        if (epoch.current !== generation) return;
        setSnapshot(result); setError(null);
      } catch (reason) {
        if (epoch.current === generation) setError(normalizeCommandError(reason).message);
      } finally {
        if (epoch.current === generation) setLoading(false);
        if (epoch.current === generation) inFlight.current = null;
      }
    })();
    inFlight.current = pending;
    return pending;
  }, []);
  const clear = useCallback(() => {
    ++epoch.current; inFlight.current = null;
    setSnapshot(null); setLoading(false); setError(null);
  }, []);
  return { snapshot, loading, error, refresh, clear };
}
export type GpuEnergyController = ReturnType<typeof useGpuEnergyMonitor>;
