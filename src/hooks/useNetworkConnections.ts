import { useCallback, useEffect, useRef, useState } from "react";

import { getNetworkConnections } from "../api";
import type { CommandError, NetworkConnectionsSnapshot } from "../types";
import { normalizeCommandError } from "../utils";

export const NETWORK_CONNECTION_REFRESH_INTERVAL_MS = 5_000;

export function useNetworkConnections(
  enabled: boolean,
  paused: boolean,
  refreshIntervalMs = NETWORK_CONNECTION_REFRESH_INTERVAL_MS,
) {
  const [snapshot, setSnapshot] = useState<NetworkConnectionsSnapshot | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [loading, setLoading] = useState(true);
  const requestInFlight = useRef(false);

  const refreshNow = useCallback(async () => {
    if (requestInFlight.current) return;

    requestInFlight.current = true;
    try {
      const nextSnapshot = await getNetworkConnections();
      setSnapshot(nextSnapshot);
      setError(null);
    } catch (caughtError) {
      setError(normalizeCommandError(caughtError));
    } finally {
      setLoading(false);
      requestInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled || paused) return;

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refreshNow();
      if (!cancelled) timeout = setTimeout(tick, refreshIntervalMs);
    };
    void tick();

    return () => {
      cancelled = true;
      if (timeout !== undefined) clearTimeout(timeout);
    };
  }, [enabled, paused, refreshIntervalMs, refreshNow]);

  return { snapshot, error, loading, refreshNow };
}
