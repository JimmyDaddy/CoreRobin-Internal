import { useCallback, useEffect, useRef, useState } from "react";

import { getStartupItems } from "../api";
import type { CommandError, StartupItemsSnapshot } from "../types";
import { normalizeCommandError } from "../utils";

export function useStartupItems(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<StartupItemsSnapshot | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await getStartupItems());
    } catch (caughtError) {
      setError(normalizeCommandError(caughtError));
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled && !snapshot && !loading) void refresh();
  }, [enabled, loading, refresh, snapshot]);

  return { snapshot, error, loading, refresh };
}
