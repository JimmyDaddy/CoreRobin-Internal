import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { getSystemSnapshot, getSystemSummary } from "../api";
import type {
  CommandError,
  HistoryPoint,
  SystemHealthSnapshot,
  SystemSnapshot,
  SystemSummary,
} from "../types";
import {
  assertSupportedSnapshotSchema,
  memoryUsagePercent,
  normalizeCommandError,
} from "../utils";

const MAX_HISTORY_POINTS = 300;
const HISTORY_WINDOW_MS = 5 * 60 * 1_000;
export const HIDDEN_SYSTEM_SUMMARY_INTERVAL_MS = 5_000;
export const HIDDEN_SYSTEM_SNAPSHOT_INTERVAL_MS = 30_000;

export function useSystemMonitor(refreshIntervalMs = 1_000, visible = true) {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [summary, setSummary] = useState<SystemSummary | null>(null);
  const [healthSnapshot, setHealthSnapshot] =
    useState<SystemHealthSnapshot | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [error, setError] = useState<CommandError | null>(null);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const lastSequence = useRef(0);
  const requestInFlight = useRef<Promise<SystemSnapshot | null> | null>(null);
  const summaryRequestInFlight = useRef<Promise<SystemSummary | null> | null>(null);
  const lastFullSnapshotAtRef = useRef(0);
  const visibleRef = useRef(visible);
  const pausedRef = useRef(paused);
  visibleRef.current = visible;
  pausedRef.current = paused;

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
        setHealthSnapshot(nextSnapshot);
        setError(null);
        appendHistorySample(setHistory, nextSnapshot);
        return nextSnapshot;
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
  }, []);
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
        appendHistorySample(setHistory, nextSummary);
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
          Date.now() - lastFullSnapshotAtRef.current >=
          HIDDEN_SYSTEM_SNAPSHOT_INTERVAL_MS
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
    refreshBackgroundSnapshotNow,
    refreshIntervalMs,
    refreshNow,
    refreshSummaryNow,
    visible,
  ]);

  return {
    snapshot,
    summary,
    healthSnapshot,
    history,
    error,
    paused,
    setPaused,
    loading,
    refreshNow,
    refreshBackgroundSnapshotNow,
    refreshSummaryNow,
  };
}

function appendHistorySample(
  setHistory: Dispatch<SetStateAction<HistoryPoint[]>>,
  snapshot: SystemHealthSnapshot,
): void {
  if (snapshot.cpu.usagePercent === null) return;
  setHistory((current) => {
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
    };
    const cutoff = snapshot.sampledAtMs - HISTORY_WINDOW_MS;
    return [...current, point]
      .filter((candidate) => candidate.timestamp >= cutoff)
      .slice(-MAX_HISTORY_POINTS);
  });
}
