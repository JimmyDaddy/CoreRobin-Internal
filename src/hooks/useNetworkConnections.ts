import { useCallback, useEffect, useRef, useState } from "react";

import { getNetworkConnections } from "../api";
import type { CommandError, NetworkConnectionsSnapshot } from "../types";
import { normalizeCommandError } from "../utils";

export const NETWORK_CONNECTION_REFRESH_INTERVAL_MS = 5_000;
export const BACKGROUND_NETWORK_CONNECTION_REFRESH_INTERVAL_MS = 30_000;

export function useNetworkConnections(
  enabled: boolean,
  paused: boolean,
  refreshIntervalMs = NETWORK_CONNECTION_REFRESH_INTERVAL_MS,
  visible = true,
  backgroundEnabled = false,
) {
  const [snapshot, setSnapshot] = useState<NetworkConnectionsSnapshot | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const samplingEnabledRef = useRef(
    enabled && !paused && (visible || backgroundEnabled),
  );
  samplingEnabledRef.current =
    enabled && !paused && (visible || backgroundEnabled);

  const refreshNow = useCallback(async () => {
    if (!enabledRef.current || requestInFlight.current) return;

    requestInFlight.current = true;
    setLoading(true);
    try {
      const nextSnapshot = await getNetworkConnections();
      if (!enabledRef.current) return;
      setSnapshot(nextSnapshot);
      setError(null);
    } catch (caughtError) {
      if (enabledRef.current) {
        setError(normalizeCommandError(caughtError));
      }
    } finally {
      if (enabledRef.current) setLoading(false);
      requestInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled || paused || (!visible && !backgroundEnabled)) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refreshNow();
      if (!cancelled) {
        timeout = setTimeout(
          tick,
          visible
            ? refreshIntervalMs
            : BACKGROUND_NETWORK_CONNECTION_REFRESH_INTERVAL_MS,
        );
      }
    };
    void tick();

    return () => {
      cancelled = true;
      if (timeout !== undefined) clearTimeout(timeout);
    };
  }, [
    backgroundEnabled,
    enabled,
    paused,
    refreshIntervalMs,
    refreshNow,
    visible,
  ]);

  return { snapshot, error, loading, refreshNow };
}
