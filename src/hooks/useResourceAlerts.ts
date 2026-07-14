import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  clearResourceAlertStorage,
  loadResourceAlertEvents,
  mergeResourceAlertEvents,
  saveResourceAlertEvents,
} from "../alertStore";
import type { HistoryRetentionDays } from "../historyStore";
import {
  activeResourceAlerts,
  createResourceAlertEvaluationState,
  evaluateResourceAlerts,
  type ActiveResourceAlert,
  type ResourceAlertEvent,
} from "../resourceAlerts";
import type { UsageThresholds } from "../settings";
import { volumeUsage } from "../storageExplorer";
import type { SystemSnapshot } from "../types";
import { memoryUsagePercent } from "../utils";

export function useResourceAlerts(
  snapshot: SystemSnapshot | null,
  thresholds: UsageThresholds,
  persistenceEnabled: boolean,
  retentionDays: HistoryRetentionDays,
) {
  const evaluationRef = useRef(createResourceAlertEvaluationState());
  const [activeAlerts, setActiveAlerts] = useState<ActiveResourceAlert[]>([]);
  const [sessionEvents, setSessionEvents] = useState<ResourceAlertEvent[]>([]);
  const [storedEvents, setStoredEvents] = useState<ResourceAlertEvent[]>(
    loadResourceAlertEvents,
  );

  useEffect(() => {
    if (!snapshot) return;
    const volumePercent = snapshot.disk.volumes.reduce<number | null>(
      (highest, volume) => {
        const usagePercent = volumeUsage(volume).usagePercent;
        return highest === null ? usagePercent : Math.max(highest, usagePercent);
      },
      null,
    );
    const result = evaluateResourceAlerts(
      evaluationRef.current,
      [
        { resource: "cpu", valuePercent: snapshot.cpu.usagePercent },
        {
          resource: "memory",
          valuePercent: memoryUsagePercent(
            snapshot.memory.usedBytes,
            snapshot.memory.totalBytes,
          ),
        },
        { resource: "volume", valuePercent: volumePercent },
      ],
      snapshot.sampledAtMs,
      thresholds,
    );
    evaluationRef.current = result.state;
    setActiveAlerts(activeResourceAlerts(result.state));

    if (result.events.length === 0) return;
    setSessionEvents((current) =>
      mergeResourceAlertEvents(
        current,
        result.events,
        snapshot.sampledAtMs,
        retentionDays,
      ),
    );
    if (persistenceEnabled) {
      setStoredEvents((current) => {
        const next = mergeResourceAlertEvents(
          current,
          result.events,
          snapshot.sampledAtMs,
          retentionDays,
        );
        saveResourceAlertEvents(next);
        return next;
      });
    }
  }, [persistenceEnabled, retentionDays, snapshot, thresholds]);

  useEffect(() => {
    setStoredEvents((current) => {
      const next = mergeResourceAlertEvents(current, [], Date.now(), retentionDays);
      saveResourceAlertEvents(next);
      return next;
    });
  }, [retentionDays]);

  const events = useMemo(
    () =>
      mergeResourceAlertEvents(
        storedEvents,
        sessionEvents,
        Date.now(),
        retentionDays,
      ),
    [retentionDays, sessionEvents, storedEvents],
  );

  const clearSaved = useCallback(() => {
    clearResourceAlertStorage();
    setStoredEvents([]);
  }, []);

  return { activeAlerts, events, storedEvents, clearSaved };
}
