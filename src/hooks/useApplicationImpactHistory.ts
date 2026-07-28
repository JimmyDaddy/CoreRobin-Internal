import { useCallback, useEffect, useRef, useState } from "react";

import {
  APPLICATION_IMPACT_HISTORY_STORAGE_KEY,
  clearApplicationImpactHistory,
  loadApplicationImpactHistory,
  mergeApplicationImpactHistory,
  parseApplicationImpactHistory,
  saveApplicationImpactHistory,
  serializeApplicationImpactHistory,
  type ApplicationImpactHistoryPoint,
} from "../applicationImpactHistory";
import {
  clearPersistedApplicationHistory,
  isDesktopRuntime,
  loadPersistedApplicationHistory,
  savePersistedApplicationHistory,
} from "../api";
import { aggregateApplications } from "../diagnosis";
import { isProductDataResetInProgress } from "../productSupport";
import type { SystemSnapshot } from "../types";

const APPLICATION_HISTORY_FLUSH_INTERVAL_MS = 30_000;

export interface ApplicationImpactHistoryStorageStatus {
  state: "loading" | "ready" | "failed";
  byteSize: number;
  lastSavedAtMs: number | null;
  error: string | null;
}

export function useApplicationImpactHistory(
  snapshot: SystemSnapshot | null,
  enabled: boolean,
  applicationNamesAllowed: boolean,
) {
  const desktop = isDesktopRuntime();
  const [points, setPoints] = useState<ApplicationImpactHistoryPoint[]>(
    () => desktop ? [] : loadApplicationImpactHistory(),
  );
  const [hydrated, setHydrated] = useState(!desktop);
  const [storageStatus, setStorageStatus] =
    useState<ApplicationImpactHistoryStorageStatus>(() => ({
      state: desktop ? "loading" : "ready",
      byteSize: desktop
        ? 0
        : new TextEncoder().encode(
          window.localStorage.getItem(APPLICATION_IMPACT_HISTORY_STORAGE_KEY)
            ?? "",
        ).byteLength,
      lastSavedAtMs: null,
      error: null,
    }));
  const pointsRef = useRef(points);
  const lastSavedAtRef = useRef(0);
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  pointsRef.current = points;

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void loadPersistedApplicationHistory()
      .then(async (stored) => {
        if (!active) return;
        const nativePoints = parseApplicationImpactHistory(stored.payload);
        const legacyPoints = loadApplicationImpactHistory();
        const nextPoints = nativePoints.length > 0 ? nativePoints : legacyPoints;
        setPoints(nextPoints);
        setHydrated(true);
        setStorageStatus({
          state: "ready",
          byteSize: stored.byteSize,
          lastSavedAtMs: stored.updatedAtMs,
          error: null,
        });
        if (nativePoints.length === 0 && legacyPoints.length > 0) {
          const migrated = await savePersistedApplicationHistory(
            serializeApplicationImpactHistory(legacyPoints),
          );
          clearApplicationImpactHistory();
          if (active) {
            setStorageStatus({
              state: "ready",
              byteSize: migrated.byteSize,
              lastSavedAtMs: migrated.updatedAtMs,
              error: null,
            });
          }
        }
      })
      .catch((reason) => {
        if (!active) return;
        setPoints(loadApplicationImpactHistory());
        setHydrated(true);
        setStorageStatus({
          state: "failed",
          byteSize: 0,
          lastSavedAtMs: null,
          error: reason instanceof Error ? reason.message : String(reason),
        });
      });
    return () => {
      active = false;
    };
  }, [desktop]);

  useEffect(() => {
    if (applicationNamesAllowed || pointsRef.current.length === 0) return;
    clearApplicationImpactHistory();
    if (desktop) {
      void clearPersistedApplicationHistory().catch(() => undefined);
    }
    setPoints([]);
    setStorageStatus((current) => ({
      ...current,
      byteSize: 0,
      lastSavedAtMs: null,
      error: null,
    }));
  }, [applicationNamesAllowed, desktop]);

  useEffect(() => {
    if (!enabled || !snapshot || !hydrated) return;
    setPoints((current) => mergeApplicationImpactHistory(
      current,
      aggregateApplications(snapshot.processes),
      snapshot.sampledAtMs,
    ));
  }, [enabled, hydrated, snapshot?.sequence]);

  useEffect(() => {
    if (!enabled || !hydrated) return;
    const persist = async () => {
      try {
        if (desktop) {
          const saved = await savePersistedApplicationHistory(
            serializeApplicationImpactHistory(pointsRef.current),
          );
          setStorageStatus({
            state: "ready",
            byteSize: saved.byteSize,
            lastSavedAtMs: saved.updatedAtMs,
            error: null,
          });
        } else {
          const saved = saveApplicationImpactHistory(pointsRef.current);
          setStorageStatus({
            state: saved.succeeded ? "ready" : "failed",
            byteSize: saved.byteSize,
            lastSavedAtMs: saved.succeeded ? Date.now() : null,
            error: saved.error,
          });
        }
      } catch (reason) {
        setStorageStatus((current) => ({
          ...current,
          state: "failed",
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      }
    };
    const flush = () => {
      if (isProductDataResetInProgress()) return;
      const now = Date.now();
      if (
        saveInFlightRef.current
        || now - lastSavedAtRef.current < APPLICATION_HISTORY_FLUSH_INTERVAL_MS
      ) {
        return;
      }
      lastSavedAtRef.current = now;
      const request = persist().finally(() => {
        if (saveInFlightRef.current === request) saveInFlightRef.current = null;
      });
      saveInFlightRef.current = request;
    };
    flush();
    const interval = window.setInterval(flush, APPLICATION_HISTORY_FLUSH_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [desktop, enabled, hydrated]);

  const clear = useCallback(() => {
    clearApplicationImpactHistory();
    if (desktop) {
      void clearPersistedApplicationHistory().catch((reason) => {
        setStorageStatus((current) => ({
          ...current,
          state: "failed",
          error: reason instanceof Error ? reason.message : String(reason),
        }));
      });
    }
    setPoints([]);
    setStorageStatus((current) => ({
      ...current,
      byteSize: 0,
      lastSavedAtMs: null,
    }));
  }, [desktop]);

  return {
    points,
    storedPointCount: points.length,
    storageStatus,
    clear,
  };
}
