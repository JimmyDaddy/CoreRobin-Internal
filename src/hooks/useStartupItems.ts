import { useCallback, useEffect, useRef, useState } from "react";

import { getStartupItems } from "../api";
import type { CommandError, StartupItemsSnapshot } from "../types";
import { normalizeCommandError } from "../utils";

export function useStartupItems(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<StartupItemsSnapshot | null>(null);
  const [error, setError] = useState<CommandError | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef(false);
  const enabledRef = useRef(enabled);
  const lastLoadedAtRef = useRef(0);
  enabledRef.current = enabled;

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await getStartupItems());
      lastLoadedAtRef.current = Date.now();
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

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (
        enabledRef.current
        && document.visibilityState === "visible"
        && Date.now() - lastLoadedAtRef.current >= 5_000
      ) {
        void refresh();
      }
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [refresh]);

  return { snapshot, error, loading, refresh };
}
