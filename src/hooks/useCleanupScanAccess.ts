import { useCallback, useEffect, useRef, useState } from "react";

import { getCleanupScanAccess } from "../api";
import type { CleanupScanAccess, CommandError } from "../types";
import { normalizeCommandError } from "../utils";

export function useCleanupScanAccess(enabled = true) {
  const [access, setAccess] = useState<CleanupScanAccess | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<CommandError | null>(null);
  const inFlightRef = useRef<Promise<CleanupScanAccess | null> | null>(null);

  const refresh = useCallback(() => {
    if (inFlightRef.current) return inFlightRef.current;
    setChecking(true);
    setError(null);
    const request = getCleanupScanAccess()
      .then((nextAccess) => {
        setAccess(nextAccess);
        return nextAccess;
      })
      .catch((reason) => {
        setAccess(null);
        setError(normalizeCommandError(reason));
        return null;
      })
      .finally(() => {
        setChecking(false);
        inFlightRef.current = null;
      });
    inFlightRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [enabled, refresh]);

  return { access, checking, error, refresh };
}
