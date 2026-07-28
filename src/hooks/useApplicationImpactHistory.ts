import { useCallback, useEffect, useRef, useState } from "react";

import {
  clearApplicationImpactHistory,
  loadApplicationImpactHistory,
  mergeApplicationImpactHistory,
  saveApplicationImpactHistory,
  type ApplicationImpactHistoryPoint,
} from "../applicationImpactHistory";
import { aggregateApplications } from "../diagnosis";
import { isProductDataResetInProgress } from "../productSupport";
import type { SystemSnapshot } from "../types";

const APPLICATION_HISTORY_FLUSH_INTERVAL_MS = 30_000;

export function useApplicationImpactHistory(
  snapshot: SystemSnapshot | null,
  enabled: boolean,
  applicationNamesAllowed: boolean,
) {
  const [points, setPoints] = useState<ApplicationImpactHistoryPoint[]>(
    loadApplicationImpactHistory,
  );
  const pointsRef = useRef(points);
  const lastSavedAtRef = useRef(0);
  pointsRef.current = points;

  useEffect(() => {
    if (applicationNamesAllowed || pointsRef.current.length === 0) return;
    clearApplicationImpactHistory();
    setPoints([]);
  }, [applicationNamesAllowed]);

  useEffect(() => {
    if (!enabled || !snapshot) return;
    setPoints((current) => mergeApplicationImpactHistory(
      current,
      aggregateApplications(snapshot.processes),
      snapshot.sampledAtMs,
    ));
  }, [enabled, snapshot?.sequence]);

  useEffect(() => {
    if (!enabled) return;
    const flush = () => {
      if (isProductDataResetInProgress()) return;
      const now = Date.now();
      if (now - lastSavedAtRef.current < APPLICATION_HISTORY_FLUSH_INTERVAL_MS) {
        return;
      }
      saveApplicationImpactHistory(pointsRef.current);
      lastSavedAtRef.current = now;
    };
    flush();
    const interval = window.setInterval(flush, APPLICATION_HISTORY_FLUSH_INTERVAL_MS);
    const flushOnExit = () => saveApplicationImpactHistory(pointsRef.current);
    window.addEventListener("pagehide", flushOnExit);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("pagehide", flushOnExit);
    };
  }, [enabled]);

  const clear = useCallback(() => {
    clearApplicationImpactHistory();
    setPoints([]);
  }, []);

  return {
    points,
    storedPointCount: points.length,
    clear,
  };
}
