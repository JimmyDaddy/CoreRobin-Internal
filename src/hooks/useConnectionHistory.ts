import { useCallback, useEffect, useRef, useState } from "react";

import { resolveNetworkHosts } from "../api";
import {
  clearConnectionHistory,
  loadConnectionHistory,
  mergeConnectionHistory,
  saveConnectionHistory,
  type ConnectionHistoryEntry,
} from "../connectionHistory";
import type { NetworkConnectionsSnapshot, ProcessRow } from "../types";
import { normalizeCommandError } from "../utils";

export function useConnectionHistory(
  snapshot: NetworkConnectionsSnapshot | null,
  processes: ProcessRow[],
  enabled: boolean,
  retentionDays: number,
) {
  const [entries, setEntries] = useState<ConnectionHistoryEntry[]>(() =>
    enabled ? loadConnectionHistory(window.localStorage) : [],
  );
  const [error, setError] = useState<string | null>(null);
  const lastSampledAtRef = useRef(0);
  const processesRef = useRef(processes);
  processesRef.current = processes;

  useEffect(() => {
    if (!enabled) {
      setEntries([]);
      lastSampledAtRef.current = 0;
      return;
    }
    setEntries(loadConnectionHistory(window.localStorage));
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !snapshot || snapshot.sampledAtMs === lastSampledAtRef.current) return;
    lastSampledAtRef.current = snapshot.sampledAtMs;
    let cancelled = false;
    const addresses = [...new Set(snapshot.connections
      .map((connection) => connection.remoteEndpoint?.address)
      .filter((address): address is string => Boolean(address)))]
      .slice(0, 32);

    void resolveNetworkHosts(addresses)
      .then((lookups) => {
        if (cancelled) return;
        setError(null);
        setEntries((current) => {
          const next = mergeConnectionHistory(
            current,
            snapshot,
            processesRef.current,
            lookups,
            retentionDays,
          );
          saveConnectionHistory(window.localStorage, next);
          return next;
        });
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(normalizeCommandError(reason).message);
        setEntries((current) => {
          const next = mergeConnectionHistory(
            current,
            snapshot,
            processesRef.current,
            [],
            retentionDays,
          );
          saveConnectionHistory(window.localStorage, next);
          return next;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, retentionDays, snapshot]);

  const clear = useCallback(() => {
    clearConnectionHistory(window.localStorage);
    setEntries([]);
  }, []);

  return { entries, error, clear };
}
