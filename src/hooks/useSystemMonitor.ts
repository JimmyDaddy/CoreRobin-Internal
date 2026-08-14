import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";

import {
  getSamplerStatus,
  getSystemSnapshot,
  getSystemSummary,
  isDesktopRuntime,
  reportFrontendHeartbeat,
  setSamplerControl,
} from "../api";
import type {
  CommandError,
  HistoryPoint,
  SystemHealthSnapshot,
  SystemSnapshot,
  SystemSummary,
  SamplerStatus,
} from "../types";
import {
  assertSupportedSnapshotSchema,
  memoryUsagePercent,
  normalizeCommandError,
} from "../utils";

const MAX_HISTORY_POINTS = 300;
const HISTORY_WINDOW_MS = 5 * 60 * 1_000;
const BATTERY_DRAIN_MIN_WINDOW_MS = 2 * 60 * 1_000;
export const HIDDEN_SYSTEM_SUMMARY_INTERVAL_MS = 5_000;
export const HIDDEN_SYSTEM_SNAPSHOT_INTERVAL_MS = 30_000;
export const SYSTEM_SNAPSHOT_EVENT = "core-robin:system-snapshot";
export const SYSTEM_SUMMARY_EVENT = "core-robin:system-summary";
export const SAMPLER_STATUS_EVENT = "core-robin:sampler-status";
export const FRONTEND_HEARTBEAT_INTERVAL_MS = 5_000;

export function useSystemMonitor(
  refreshIntervalMs = 1_000,
  visible = true,
  hiddenFullSnapshotIntervalMs: number | null =
    HIDDEN_SYSTEM_SNAPSHOT_INTERVAL_MS,
  includeApplicationNames = false,
) {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [summary, setSummary] = useState<SystemSummary | null>(null);
  const [healthSnapshot, setHealthSnapshot] =
    useState<SystemHealthSnapshot | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [error, setError] = useState<CommandError | null>(null);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [samplerStatus, setSamplerStatus] = useState<SamplerStatus | null>(null);
  const lastSequence = useRef(0);
  const requestInFlight = useRef<Promise<SystemSnapshot | null> | null>(null);
  const summaryRequestInFlight = useRef<Promise<SystemSummary | null> | null>(null);
  const lastFullSnapshotAtRef = useRef(0);
  const visibleRef = useRef(visible);
  const pausedRef = useRef(paused);
  const includeApplicationNamesRef = useRef(includeApplicationNames);
  const refreshIntervalMsRef = useRef(refreshIntervalMs);
  const hiddenFullSnapshotIntervalMsRef = useRef(hiddenFullSnapshotIntervalMs);
  visibleRef.current = visible;
  pausedRef.current = paused;
  includeApplicationNamesRef.current = includeApplicationNames;
  refreshIntervalMsRef.current = refreshIntervalMs;
  hiddenFullSnapshotIntervalMsRef.current = hiddenFullSnapshotIntervalMs;
  const desktop = isDesktopRuntime();

  const applySnapshot = useCallback((
    nextSnapshot: SystemSnapshot,
    allowHidden = true,
  ) => {
    assertSupportedSnapshotSchema(nextSnapshot);
    if (
      pausedRef.current ||
      (!visibleRef.current && !allowHidden) ||
      nextSnapshot.sequence <= lastSequence.current
    ) {
      return null;
    }
    lastSequence.current = nextSnapshot.sequence;
    lastFullSnapshotAtRef.current = Date.now();
    setSnapshot(nextSnapshot);
    setSummary(summaryFromSnapshot(nextSnapshot));
    setHealthSnapshot(nextSnapshot);
    setError(null);
    setLoading(false);
    appendHistorySample(
      setHistory,
      nextSnapshot,
      includeApplicationNamesRef.current,
    );
    return nextSnapshot;
  }, []);

  const applySummary = useCallback((nextSummary: SystemSummary) => {
    if (
      pausedRef.current
      || visibleRef.current
      || nextSummary.sequence <= lastSequence.current
    ) {
      return null;
    }
    lastSequence.current = nextSummary.sequence;
    setSummary(nextSummary);
    setHealthSnapshot(nextSummary);
    appendHistorySample(
      setHistory,
      nextSummary,
      includeApplicationNamesRef.current,
    );
    setError(null);
    setLoading(false);
    return nextSummary;
  }, []);

  const refreshSnapshot = useCallback((allowHidden = false) => {
    if (pausedRef.current || (!visibleRef.current && !allowHidden)) {
      return Promise.resolve(null);
    }
    if (requestInFlight.current) {
      return requestInFlight.current;
    }

    const request = (async () => {
      try {
        const nextSnapshot = await getSystemSnapshot();
        return applySnapshot(nextSnapshot, allowHidden);
      } catch (caughtError) {
        setError(normalizeCommandError(caughtError));
        return null;
      } finally {
        setLoading(false);
      }
    })();
    requestInFlight.current = request;
    void request.finally(() => {
      if (requestInFlight.current === request) requestInFlight.current = null;
    });
    return request;
  }, [applySnapshot]);
  const refreshNow = useCallback(
    () => refreshSnapshot(false),
    [refreshSnapshot],
  );
  const refreshBackgroundSnapshotNow = useCallback(
    () => refreshSnapshot(true),
    [refreshSnapshot],
  );

  const refreshSummaryNow = useCallback(() => {
    if (pausedRef.current || visibleRef.current) {
      return Promise.resolve(null);
    }
    if (summaryRequestInFlight.current) {
      return summaryRequestInFlight.current;
    }

    const request = (async () => {
      try {
        const nextSummary = await getSystemSummary();
        if (
          pausedRef.current ||
          visibleRef.current ||
          nextSummary.sequence <= lastSequence.current
        ) return null;
        lastSequence.current = nextSummary.sequence;
        setSummary(nextSummary);
        setHealthSnapshot(nextSummary);
        appendHistorySample(
          setHistory,
          nextSummary,
          includeApplicationNamesRef.current,
        );
        setError(null);
        return nextSummary;
      } catch (caughtError) {
        if (!pausedRef.current && !visibleRef.current) {
          setError(normalizeCommandError(caughtError));
        }
        return null;
      } finally {
        setLoading(false);
      }
    })();
    summaryRequestInFlight.current = request;
    void request.finally(() => {
      if (summaryRequestInFlight.current === request) {
        summaryRequestInFlight.current = null;
      }
    });
    return request;
  }, []);

  useEffect(() => {
    if (desktop) return;
    if (paused) {
      return;
    }

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (visible) {
        await refreshNow();
      } else {
        await refreshSummaryNow();
        if (
          hiddenFullSnapshotIntervalMs !== null &&
          Date.now() - lastFullSnapshotAtRef.current >=
            hiddenFullSnapshotIntervalMs
        ) {
          await refreshBackgroundSnapshotNow();
        }
      }
      if (!cancelled) {
        timeout = setTimeout(
          tick,
          visible ? refreshIntervalMs : HIDDEN_SYSTEM_SUMMARY_INTERVAL_MS,
        );
      }
    };
    void tick();

    return () => {
      cancelled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    };
  }, [
    paused,
    hiddenFullSnapshotIntervalMs,
    refreshBackgroundSnapshotNow,
    refreshIntervalMs,
    refreshNow,
    refreshSummaryNow,
    visible,
    desktop,
  ]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    const unlisteners: (() => void)[] = [];
    void Promise.all([
      listen<SystemSnapshot>(SYSTEM_SNAPSHOT_EVENT, ({ payload }) => {
        if (!disposed) applySnapshot(payload, true);
      }),
      listen<SystemSummary>(SYSTEM_SUMMARY_EVENT, ({ payload }) => {
        if (!disposed) applySummary(payload);
      }),
      listen<SamplerStatus>(SAMPLER_STATUS_EVENT, ({ payload }) => {
        if (disposed) return;
        setSamplerStatus(payload);
        if (payload.degradedReason) {
          setError({
            code: "sampler_degraded",
            message: payload.degradedReason,
          });
        }
      }),
    ]).then((next) => {
      if (disposed) {
        next.forEach((unlisten) => unlisten());
      } else {
        unlisteners.push(...next);
      }
    });
    void getSamplerStatus().then((status) => {
      if (!disposed) setSamplerStatus(status);
    }).catch(() => undefined);
    void refreshSnapshot(true);
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [applySnapshot, applySummary, desktop, refreshSnapshot]);

  useEffect(() => {
    if (!desktop) return;
    void setSamplerControl({
      active: visible,
      paused,
      intervalMs: visible ? refreshIntervalMs : null,
      fullSnapshotIntervalMs: visible ? null : hiddenFullSnapshotIntervalMs,
    }).then(setSamplerStatus).catch((caughtError) => {
      setError(normalizeCommandError(caughtError));
    });
  }, [
    desktop,
    hiddenFullSnapshotIntervalMs,
    paused,
    refreshIntervalMs,
    visible,
  ]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let failureCount = 0;
    let timer: number | null = null;
    const heartbeat = async () => {
      try {
        const status = await reportFrontendHeartbeat();
        if (disposed) return;
        failureCount = 0;
        setSamplerStatus(status);
      } catch (caughtError) {
        if (disposed) return;
        failureCount += 1;
        if (failureCount >= 3) {
          setError({
            code: "sampler_heartbeat_lost",
            message: normalizeCommandError(caughtError).message,
          });
          try {
            const status = await setSamplerControl({
              active: visibleRef.current,
              paused: pausedRef.current,
              intervalMs: visibleRef.current
                ? refreshIntervalMsRef.current
                : null,
              fullSnapshotIntervalMs: visibleRef.current
                ? null
                : hiddenFullSnapshotIntervalMsRef.current,
            });
            if (!disposed) {
              failureCount = 0;
              setSamplerStatus(status);
              void refreshSnapshot(true);
            }
          } catch {
            // The next heartbeat retries the same idempotent recovery.
          }
        }
      } finally {
        if (!disposed) {
          timer = window.setTimeout(heartbeat, FRONTEND_HEARTBEAT_INTERVAL_MS);
        }
      }
    };
    void heartbeat();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [desktop, refreshSnapshot]);

  return {
    snapshot,
    summary,
    healthSnapshot,
    history,
    error,
    paused,
    setPaused,
    loading,
    samplerStatus,
    refreshNow,
    refreshBackgroundSnapshotNow,
    refreshSummaryNow,
  };
}

function summaryFromSnapshot(snapshot: SystemSnapshot): SystemSummary {
  return {
    sequence: snapshot.sequence,
    sampledAtMs: snapshot.sampledAtMs,
    sampleIntervalMs: snapshot.sampleIntervalMs,
    cpu: snapshot.cpu,
    memory: snapshot.memory,
    disk: snapshot.disk,
    network: snapshot.network,
    sensors: snapshot.sensors,
  };
}

function appendHistorySample(
  setHistory: Dispatch<SetStateAction<HistoryPoint[]>>,
  snapshot: SystemHealthSnapshot,
  includeApplicationNames: boolean,
): void {
  if (snapshot.cpu.usagePercent === null) return;
  setHistory((current) => {
    const batteryChargePercent = snapshot.sensors.battery.chargePercent;
    const batteryReference = current.find(
      (point) =>
        point.batteryChargePercent !== null
        && point.batteryChargePercent !== undefined
        && snapshot.sampledAtMs - point.timestamp
          >= BATTERY_DRAIN_MIN_WINDOW_MS,
    );
    const elapsedHours = batteryReference
      ? (snapshot.sampledAtMs - batteryReference.timestamp)
        / (60 * 60 * 1_000)
      : 0;
    const batteryDrainPercentPerHour =
      snapshot.sensors.battery.powerSource === "battery"
      && batteryChargePercent !== null
      && batteryReference?.batteryChargePercent !== null
      && batteryReference?.batteryChargePercent !== undefined
      && elapsedHours > 0
        ? Math.max(
            0,
            Math.min(
              100,
              (batteryReference.batteryChargePercent - batteryChargePercent)
                / elapsedHours,
            ),
          )
        : null;
    const point: HistoryPoint = {
      timestamp: snapshot.sampledAtMs,
      cpuPercent: snapshot.cpu.usagePercent ?? 0,
      memoryPercent: memoryUsagePercent(
        snapshot.memory.usedBytes,
        snapshot.memory.totalBytes,
      ),
      diskReadBytesPerSecond: snapshot.disk.readBytesPerSecond,
      diskWriteBytesPerSecond: snapshot.disk.writeBytesPerSecond,
      networkReceivedBytesPerSecond:
        snapshot.network.receivedBytesPerSecond,
      networkTransmittedBytesPerSecond:
        snapshot.network.transmittedBytesPerSecond,
      temperatureCelsius: snapshot.sensors.temperature.celsius,
      batteryChargePercent,
      batteryDrainPercentPerHour,
      batteryPowerSource: snapshot.sensors.battery.powerSource,
      sleepBlockerNames: includeApplicationNames
        ? [...new Set(
            snapshot.sensors.sleep.blockers
              .map((blocker) => blocker.processName.trim())
              .filter(Boolean),
          )].slice(0, 8)
        : [],
      topApplicationName: includeApplicationNames
        ? [...(snapshot.processes ?? [])]
            .filter((process) => !process.protected)
            .sort((left, right) =>
              (right.cpuPercent ?? 0) - (left.cpuPercent ?? 0))[0]?.name ?? null
        : null,
    };
    const cutoff = snapshot.sampledAtMs - HISTORY_WINDOW_MS;
    return [...current, point]
      .filter((candidate) => candidate.timestamp >= cutoff)
      .slice(-MAX_HISTORY_POINTS);
  });
}
