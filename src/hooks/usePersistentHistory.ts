import { useCallback, useEffect, useMemo, useRef } from "react";

import {
  clearPersistentHistoryStorage,
  loadPersistentHistory,
  mergePersistentHistory,
  parsePersistentHistory,
  savePersistentHistory,
  serializePersistentHistory,
  type HistoryRetentionDays,
} from "../historyStore";
import { isDesktopRuntime } from "../api";
import type { HistoryPoint } from "../types";
import { useNativeHistoryStorage } from "./useNativeHistoryStorage";

const HISTORY_FLUSH_INTERVAL_MS = 30_000;

export function usePersistentHistory(
  liveHistory: readonly HistoryPoint[],
  enabled: boolean,
  retentionDays: HistoryRetentionDays,
  active = true,
) {
  const desktop = isDesktopRuntime();
  const storage = useNativeHistoryStorage<HistoryPoint[]>({
    category: "resource",
    enabled,
    initialValue: loadPersistentHistory,
    parse: parsePersistentHistory,
    serialize: serializePersistentHistory,
    clearLegacy: clearPersistentHistoryStorage,
    flushDelayMs: HISTORY_FLUSH_INTERVAL_MS,
  });
  const storedPoints = storage.value;
  const setStoredPoints = storage.setValue;
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
      if (!desktop) savePersistentHistory(next);
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
      if (!desktop) savePersistentHistory(next);
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
      if (!desktop) savePersistentHistory(
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
    void storage.clear().catch(() => undefined);
  }, [storage]);

  return {
    points,
    storedPoints,
    clear,
    storageStatus: storage.storageStatus,
  };
}
