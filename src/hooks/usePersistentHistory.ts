import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  clearPersistentHistoryStorage,
  loadPersistentHistory,
  mergePersistentHistory,
  savePersistentHistory,
  type HistoryRetentionDays,
} from "../historyStore";
import type { HistoryPoint } from "../types";

const HISTORY_FLUSH_INTERVAL_MS = 30_000;

export function usePersistentHistory(
  liveHistory: readonly HistoryPoint[],
  enabled: boolean,
  retentionDays: HistoryRetentionDays,
  active = true,
) {
  const [storedPoints, setStoredPoints] = useState<HistoryPoint[]>(
    loadPersistentHistory,
  );
  const latestPointRef = useRef<HistoryPoint | null>(null);
  const enabledRef = useRef(enabled);
  const retentionDaysRef = useRef(retentionDays);

  latestPointRef.current = liveHistory[liveHistory.length - 1] ?? null;
  enabledRef.current = enabled;
  retentionDaysRef.current = retentionDays;

  const flushLatest = useCallback(() => {
    const latest = latestPointRef.current;
    if (!enabledRef.current || !latest) return;
    setStoredPoints((current) => {
      const next = mergePersistentHistory(
        current,
        [latest],
        Date.now(),
        retentionDaysRef.current,
      );
      savePersistentHistory(next);
      return next;
    });
  }, []);

  useEffect(() => {
    setStoredPoints((current) => {
      const next = mergePersistentHistory(
        current,
        [],
        Date.now(),
        retentionDays,
      );
      savePersistentHistory(next);
      return next;
    });
  }, [retentionDays]);

  useEffect(() => {
    if (!enabled || !active) return;
    flushLatest();
    const interval = window.setInterval(flushLatest, HISTORY_FLUSH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [active, enabled, flushLatest]);

  useEffect(() => {
    const flushBeforeExit = () => {
      const latest = latestPointRef.current;
      if (!enabledRef.current || !latest) return;
      savePersistentHistory(
        mergePersistentHistory(
          storedPoints,
          [latest],
          Date.now(),
          retentionDaysRef.current,
        ),
      );
    };
    window.addEventListener("pagehide", flushBeforeExit);
    return () => window.removeEventListener("pagehide", flushBeforeExit);
  }, [storedPoints]);

  const points = useMemo(
    () =>
      mergePersistentHistory(
        storedPoints,
        liveHistory,
        Date.now(),
        retentionDays,
      ),
    [liveHistory, retentionDays, storedPoints],
  );

  const clear = useCallback(() => {
    clearPersistentHistoryStorage();
    setStoredPoints([]);
  }, []);

  return { points, storedPoints, clear };
}
