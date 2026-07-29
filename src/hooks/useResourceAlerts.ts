import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  clearResourceAlertStorage,
  loadResourceAlertEvents,
  mergeResourceAlertEvents,
  parseResourceAlertEvents,
  saveResourceAlertEvents,
  serializeResourceAlertEvents,
} from "../alertStore";
import { isDesktopRuntime } from "../api";
import { alertCulpritName } from "../alertAttribution";
import { aggregateApplications } from "../diagnosis";
import type { HistoryRetentionDays } from "../historyStore";
import {
  activeResourceAlerts,
  createResourceAlertEvaluationState,
  evaluateResourceAlerts,
  memoryPressureAlertPercent,
  type ActiveResourceAlert,
  type ResourceAlertEvent,
  type ResourceAlertResource,
} from "../resourceAlerts";
import type { UsageThresholds } from "../settings";
import { volumeUsage } from "../storageExplorer";
import type { SystemHealthSnapshot } from "../types";
import { useNativeHistoryStorage } from "./useNativeHistoryStorage";

export function useResourceAlerts(
  snapshot: SystemHealthSnapshot | null,
  thresholds: UsageThresholds,
  persistenceEnabled: boolean,
  retentionDays: HistoryRetentionDays,
  applicationNamesEnabled: boolean,
) {
  const evaluationRef = useRef(createResourceAlertEvaluationState());
  const culpritNamesRef = useRef<Record<ResourceAlertResource, string | null>>({
    cpu: null,
    memory: null,
    volume: null,
  });
  const [activeAlerts, setActiveAlerts] = useState<ActiveResourceAlert[]>([]);
  const [sessionEvents, setSessionEvents] = useState<ResourceAlertEvent[]>([]);
  const desktop = isDesktopRuntime();
  const storage = useNativeHistoryStorage<ResourceAlertEvent[]>({
    category: "resource-alerts",
    enabled: persistenceEnabled,
    initialValue: loadResourceAlertEvents,
    parse: parseResourceAlertEvents,
    serialize: serializeResourceAlertEvents,
    clearLegacy: clearResourceAlertStorage,
  });
  const storedEvents = storage.value;
  const setStoredEvents = storage.setValue;

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
          valuePercent: memoryPressureAlertPercent(snapshot.memory),
          alertThresholdPercent: 90,
          criticalThresholdPercent: 95,
        },
        {
          resource: "volume",
          valuePercent: volumePercent,
          alertThresholdPercent: 85,
          criticalThresholdPercent: 95,
        },
      ],
      snapshot.sampledAtMs,
      thresholds,
    );
    evaluationRef.current = result.state;
    setActiveAlerts(activeResourceAlerts(result.state));

    if (result.events.length === 0) return;
    const applications = aggregateApplications(snapshot.processes ?? []);
    const events = result.events.map((event) => {
      const culpritName = event.kind === "triggered"
        ? alertCulpritName(
            event.resource,
            applications,
            snapshot.memory.totalBytes,
          )
        : culpritNamesRef.current[event.resource];
      culpritNamesRef.current[event.resource] = event.kind === "triggered"
        ? culpritName
        : null;
      return { ...event, culpritName };
    });
    setSessionEvents((current) =>
      mergeResourceAlertEvents(
        current,
        events,
        snapshot.sampledAtMs,
        retentionDays,
      ),
    );
    if (persistenceEnabled) {
      setStoredEvents((current) => {
        const persistentEvents = applicationNamesEnabled
          ? events
          : events.map((event) => ({ ...event, culpritName: null }));
        const next = mergeResourceAlertEvents(
          current,
          persistentEvents,
          snapshot.sampledAtMs,
          retentionDays,
        );
        if (!desktop) saveResourceAlertEvents(next);
        return next;
      });
    }
  }, [applicationNamesEnabled, persistenceEnabled, retentionDays, snapshot, thresholds]);

  useEffect(() => {
    if (applicationNamesEnabled) return;
    setStoredEvents((current) => {
      const next = current.map((event) => ({ ...event, culpritName: null }));
      if (!desktop) saveResourceAlertEvents(next);
      return next;
    });
  }, [applicationNamesEnabled]);

  useEffect(() => {
    setStoredEvents((current) => {
      const next = mergeResourceAlertEvents(current, [], Date.now(), retentionDays);
      if (!desktop) saveResourceAlertEvents(next);
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
    void storage.clear().catch(() => undefined);
  }, [storage]);

  return {
    activeAlerts,
    events,
    storedEvents,
    clearSaved,
    storageStatus: storage.storageStatus,
  };
}
