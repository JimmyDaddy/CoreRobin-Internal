import { useCallback, useEffect, useRef, useState } from "react";

import { getSystemSnapshot } from "../api";
import type { CommandError, HistoryPoint, SystemSnapshot } from "../types";
import {
  assertSupportedSnapshotSchema,
  memoryUsagePercent,
  normalizeCommandError,
} from "../utils";

const MAX_HISTORY_POINTS = 300;
const HISTORY_WINDOW_MS = 5 * 60 * 1_000;

export function useSystemMonitor(refreshIntervalMs = 1_000) {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [error, setError] = useState<CommandError | null>(null);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const lastSequence = useRef(0);
  const requestInFlight = useRef(false);

  const refreshNow = useCallback(async () => {
    if (requestInFlight.current) {
      return;
    }

    requestInFlight.current = true;
    try {
      const nextSnapshot = await getSystemSnapshot();
      assertSupportedSnapshotSchema(nextSnapshot);
      if (nextSnapshot.sequence <= lastSequence.current) {
        return;
      }

      lastSequence.current = nextSnapshot.sequence;
      setSnapshot(nextSnapshot);
      setError(null);
      if (nextSnapshot.cpu.usagePercent !== null) {
        setHistory((current) => {
          const point: HistoryPoint = {
            timestamp: nextSnapshot.sampledAtMs,
            cpuPercent: nextSnapshot.cpu.usagePercent ?? 0,
            memoryPercent: memoryUsagePercent(
              nextSnapshot.memory.usedBytes,
              nextSnapshot.memory.totalBytes,
            ),
            diskReadBytesPerSecond: nextSnapshot.disk.readBytesPerSecond,
            diskWriteBytesPerSecond: nextSnapshot.disk.writeBytesPerSecond,
            networkReceivedBytesPerSecond:
              nextSnapshot.network.receivedBytesPerSecond,
            networkTransmittedBytesPerSecond:
              nextSnapshot.network.transmittedBytesPerSecond,
          };
          const cutoff = nextSnapshot.sampledAtMs - HISTORY_WINDOW_MS;
          return [...current, point]
            .filter((candidate) => candidate.timestamp >= cutoff)
            .slice(-MAX_HISTORY_POINTS);
        });
      }
    } catch (caughtError) {
      setError(normalizeCommandError(caughtError));
    } finally {
      setLoading(false);
      requestInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (paused) {
      return;
    }

    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      await refreshNow();
      if (!cancelled) {
        timeout = setTimeout(tick, refreshIntervalMs);
      }
    };
    void tick();

    return () => {
      cancelled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    };
  }, [paused, refreshIntervalMs, refreshNow]);

  return {
    snapshot,
    history,
    error,
    paused,
    setPaused,
    loading,
    refreshNow,
  };
}
