import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelCleanupScan,
  clearPersistedCleanupScan,
  getCleanupScan,
  loadPersistedCleanupScan,
  savePersistedCleanupScan,
} from "../api";
import {
  clearStoredCleanupScan,
  parseStoredCleanupScan,
  reconcileCleanupScanAfterDeletion,
  type CleanupDeletionTargetSnapshot,
  type CleanupSnapshotStatus,
} from "../cleanupScanStore";
import type { CleanupScan, CleanupScanProgress, CommandError } from "../types";
import { normalizeCommandError } from "../utils";

export function useCleanupScan() {
  const [snapshot, setSnapshot] = useState<CleanupScan | null>(null);
  const [snapshotStatus, setSnapshotStatus] = useState<CleanupSnapshotStatus>("current");
  const [error, setError] = useState<CommandError | null>(null);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<CleanupScanProgress | null>(null);
  const inFlight = useRef(false);
  const stateTouched = useRef(false);
  const snapshotRef = useRef<CleanupScan | null>(null);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    clearStoredCleanupScan();
    let disposed = false;
    void loadPersistedCleanupScan()
      .then((serialized) => parseStoredCleanupScan(serialized))
      .then((persisted) => {
        if (disposed || stateTouched.current || !persisted) return;
        snapshotRef.current = persisted.snapshot;
        setSnapshot(persisted.snapshot);
        setSnapshotStatus(persisted.status);
      })
      .catch(() => {
        // A missing or unavailable disk cache is equivalent to no prior scan.
      });
    return () => {
      disposed = true;
    };
  }, []);

  const scan = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    stateTouched.current = true;
    clearStoredCleanupScan();
    try {
      await clearPersistedCleanupScan();
    } catch {
      // A stale cache must not prevent a new scan.
    }
    setSnapshot(null);
    snapshotRef.current = null;
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
      snapshotRef.current = completed;
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

  const applyDeletion = useCallback(async (
    targets: readonly CleanupDeletionTargetSnapshot[],
    invalidateSnapshot = false,
  ) => {
    const current = snapshotRef.current;
    if (!current || (targets.length === 0 && !invalidateSnapshot)) return;
    const updated = targets.length > 0
      ? reconcileCleanupScanAfterDeletion(current, targets)
      : current;
    snapshotRef.current = updated;
    setSnapshot(updated);
    if (invalidateSnapshot) {
      setSnapshotStatus("expired");
      clearStoredCleanupScan();
      try {
        await clearPersistedCleanupScan();
      } catch {
        // The in-memory map is visibly marked as stale even if disk cleanup fails.
      }
      return;
    }
    try {
      await savePersistedCleanupScan(updated);
    } catch {
      // Never retain a pre-deletion map if the corrected snapshot cannot be saved.
      try {
        await clearPersistedCleanupScan();
      } catch {
        // The in-memory result is still authoritative for this app session.
      }
    }
  }, []);

  return {
    snapshot,
    snapshotStatus,
    error,
    loading,
    cancelling,
    progress,
    scan,
    cancel,
    applyDeletion,
  };
}
