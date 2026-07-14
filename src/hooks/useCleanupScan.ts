import { useCallback, useRef, useState } from "react";

import { cancelCleanupScan, getCleanupScan } from "../api";
import {
  clearStoredCleanupScan,
  loadStoredCleanupScan,
  saveCleanupScan,
  type CleanupSnapshotStatus,
} from "../cleanupScanStore";
import type { CleanupScan, CleanupScanProgress, CommandError } from "../types";
import { normalizeCommandError } from "../utils";

export function useCleanupScan() {
  const restored = useRef<ReturnType<typeof loadStoredCleanupScan> | undefined>(undefined);
  if (restored.current === undefined) restored.current = loadStoredCleanupScan();
  const [snapshot, setSnapshot] = useState<CleanupScan | null>(restored.current?.snapshot ?? null);
  const [snapshotStatus, setSnapshotStatus] = useState<CleanupSnapshotStatus>(restored.current?.status ?? "current");
  const [error, setError] = useState<CommandError | null>(null);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<CleanupScanProgress | null>(null);
  const inFlight = useRef(false);

  const scan = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    clearStoredCleanupScan();
    setSnapshot(null);
    setSnapshotStatus("current");
    setLoading(true);
    setCancelling(false);
    setProgress({
      scannedEntryCount: 0,
      discoveredBytes: 0,
      currentPath: "~",
      elapsedMs: 0,
    });
    setError(null);
    try {
      const completed = await getCleanupScan(setProgress);
      saveCleanupScan(completed);
      setSnapshot(completed);
      setSnapshotStatus("current");
    } catch (caughtError) {
      const normalized = normalizeCommandError(caughtError);
      if (normalized.code !== "cleanup_scan_cancelled") setError(normalized);
    } finally {
      inFlight.current = false;
      setLoading(false);
      setCancelling(false);
      setProgress(null);
    }
  }, []);

  const cancel = useCallback(async () => {
    if (!inFlight.current || cancelling) return;
    setCancelling(true);
    try {
      await cancelCleanupScan();
    } catch (caughtError) {
      setError(normalizeCommandError(caughtError));
      setCancelling(false);
    }
  }, [cancelling]);

  return {
    snapshot,
    snapshotStatus,
    error,
    loading,
    cancelling,
    progress,
    scan,
    cancel,
  };
}
