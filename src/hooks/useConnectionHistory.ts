import { useCallback, useEffect, useRef, useState } from "react";

import { isDesktopRuntime, resolveNetworkHosts } from "../api";
import {
  clearConnectionHistory,
  loadConnectionHistory,
  mergeConnectionHistory,
  parseConnectionHistory,
  saveConnectionHistory,
  serializeConnectionHistory,
  type ConnectionHistoryEntry,
} from "../connectionHistory";
import type { NetworkConnectionsSnapshot, ProcessRow } from "../types";
import { normalizeCommandError } from "../utils";
import { useNativeHistoryStorage } from "./useNativeHistoryStorage";

export function useConnectionHistory(
  snapshot: NetworkConnectionsSnapshot | null,
  processes: ProcessRow[],
  enabled: boolean,
  retentionDays: number,
) {
  const desktop = isDesktopRuntime();
  const storage = useNativeHistoryStorage<ConnectionHistoryEntry[]>({
    category: "connections",
    enabled,
    initialValue: () => loadConnectionHistory(window.localStorage),
    parse: parseConnectionHistory,
    serialize: serializeConnectionHistory,
    clearLegacy: () => clearConnectionHistory(window.localStorage),
  });
  const storedEntries = storage.value;
  const setEntries = storage.setValue;
  const entries = enabled ? storedEntries : [];
  const [error, setError] = useState<string | null>(null);
  const lastSampledAtRef = useRef(0);
  const processesRef = useRef(processes);
  processesRef.current = processes;

  useEffect(() => {
    if (!enabled) {
      lastSampledAtRef.current = 0;
      return;
    }
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
          if (!desktop) saveConnectionHistory(window.localStorage, next);
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
          if (!desktop) saveConnectionHistory(window.localStorage, next);
          return next;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, retentionDays, snapshot]);

  const clear = useCallback(() => {
    void storage.clear().catch(() => undefined);
  }, [storage]);

  return {
    entries,
    error,
    clear,
    storageStatus: storage.storageStatus,
  };
}
