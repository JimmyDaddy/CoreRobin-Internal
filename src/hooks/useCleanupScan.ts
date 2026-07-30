import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  cancelCleanupScan,
  clearPersistedCleanupScan,
  getCleanupScanJob,
  loadPersistedCleanupScan,
  loadCleanupScanJobResult,
  savePersistedCleanupScan,
  startCleanupScan,
} from "../api";
import {
  clearStoredCleanupScan,
  parseStoredCleanupScan,
  reconcileCleanupScanAfterDeletion,
  retainCleanupSubtree,
  type CleanupDeletionTargetSnapshot,
  type CleanupSnapshotStatus,
} from "../cleanupScanStore";
import type {
  CleanupNode,
  CleanupScan,
  CleanupScanJobPhase,
  CleanupScanJobStatus,
  CleanupScanProgress,
  CleanupScanTarget,
  CommandError,
} from "../types";
import { normalizeCommandError } from "../utils";
import {
  appendCleanupScanSnapshot,
  cleanupScanGrowthComparison,
  parseCleanupScanHistory,
  serializeCleanupScanHistory,
} from "../cleanupScanHistory";
import { useNativeHistoryStorage } from "./useNativeHistoryStorage";

const CLEANUP_JOB_POLL_MS = 400;

function waitForCleanupJobPoll(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, CLEANUP_JOB_POLL_MS));
}

export function useCleanupScan() {
  const scanHistory = useNativeHistoryStorage({
    category: "cleanup-scans",
    enabled: true,
    initialValue: () => [] ,
    parse: parseCleanupScanHistory,
    serialize: serializeCleanupScanHistory,
  });
  const [snapshot, setSnapshot] = useState<CleanupScan | null>(null);
  const [snapshotStatus, setSnapshotStatus] = useState<CleanupSnapshotStatus>("current");
  const [error, setError] = useState<CommandError | null>(null);
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<CleanupScanProgress | null>(null);
  const [phase, setPhase] = useState<CleanupScanJobPhase | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const trackerRef = useRef(0);
  const stateTouched = useRef(false);
  const snapshotRef = useRef<CleanupScan | null>(null);
  const persistenceQueueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueuePersistence = useCallback((operation: () => Promise<void>) => {
    const queued = persistenceQueueRef.current
      .catch(() => undefined)
      .then(operation);
    persistenceQueueRef.current = queued.catch(() => undefined);
    return queued;
  }, []);

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

  const followJob = useCallback(async (
    initialStatus: CleanupScanJobStatus,
    tracker: number,
  ) => {
    let status: CleanupScanJobStatus | null = initialStatus;
    activeJobIdRef.current = initialStatus.jobId;
    while (
      status
      && trackerRef.current === tracker
      && activeJobIdRef.current === initialStatus.jobId
    ) {
      setPhase(status.phase);
      setProgress(status.progress);
      setCancelling(status.phase === "cancelling");
      setLoading(
        status.phase === "preparing"
        || status.phase === "scanning"
        || status.phase === "paused"
        || status.phase === "cancelling"
        || status.phase === "stalled",
      );

      if (status.phase === "completed") {
        try {
          const completed = await loadCleanupScanJobResult(status.jobId);
          if (trackerRef.current !== tracker) return;
          snapshotRef.current = completed;
          setSnapshot(completed);
          setSnapshotStatus("current");
          scanHistory.setValue((current) =>
            appendCleanupScanSnapshot(current, completed));
          setError(null);
        } catch (caughtError) {
          if (trackerRef.current === tracker) {
            setError(normalizeCommandError(caughtError));
          }
        }
        activeJobIdRef.current = null;
        setLoading(false);
        setCancelling(false);
        setProgress(null);
        setPhase("completed");
        return;
      }
      if (status.phase === "cancelled") {
        activeJobIdRef.current = null;
        setLoading(false);
        setCancelling(false);
        setProgress(null);
        setPhase("cancelled");
        return;
      }
      if (status.phase === "failed") {
        activeJobIdRef.current = null;
        setLoading(false);
        setCancelling(false);
        setProgress(null);
        setPhase("failed");
        setError({
          code: status.errorCode ?? "cleanup_scan_failed",
          message: status.errorMessage ?? "The cleanup scan worker stopped unexpectedly.",
        });
        return;
      }

      await waitForCleanupJobPoll();
      if (trackerRef.current !== tracker) return;
      try {
        status = await getCleanupScanJob();
      } catch (caughtError) {
        if (trackerRef.current === tracker) {
          activeJobIdRef.current = null;
          setLoading(false);
          setCancelling(false);
          setPhase("failed");
          setError(normalizeCommandError(caughtError));
        }
        return;
      }
      if (status && status.jobId !== initialStatus.jobId) return;
    }
  }, [scanHistory.setValue]);

  useEffect(() => {
    const tracker = ++trackerRef.current;
    void getCleanupScanJob()
      .then((status) => {
        if (!status || trackerRef.current !== tracker) return;
        stateTouched.current = true;
        void followJob(status, tracker);
      })
      .catch(() => {
        // A missing native job is equivalent to no scan in progress.
      });
    return () => {
      trackerRef.current += 1;
    };
  }, [followJob]);

  const scan = useCallback(async (
    target: CleanupScanTarget = { targetKind: "system_disk", targetPath: null },
  ) => {
    const tracker = ++trackerRef.current;
    stateTouched.current = true;
    clearStoredCleanupScan();
    try {
      await enqueuePersistence(clearPersistedCleanupScan);
    } catch {
      // A stale cache must not prevent a new scan.
    }
    setSnapshot(null);
    snapshotRef.current = null;
    setSnapshotStatus("current");
    setLoading(true);
    setCancelling(false);
    setPhase("preparing");
    setProgress({
      scannedEntryCount: 0,
      discoveredBytes: 0,
      currentPath: "~",
      elapsedMs: 0,
    });
    setError(null);
    try {
      const job = await startCleanupScan(target);
      if (trackerRef.current !== tracker) return;
      void followJob(job, tracker);
    } catch (caughtError) {
      if (trackerRef.current !== tracker) return;
      const normalized = normalizeCommandError(caughtError);
      if (normalized.code !== "cleanup_scan_cancelled") setError(normalized);
      setLoading(false);
      setCancelling(false);
      setProgress(null);
      setPhase("failed");
    }
  }, [enqueuePersistence, followJob]);

  const cancel = useCallback(async () => {
    if (!activeJobIdRef.current || cancelling) return;
    setCancelling(true);
    setPhase("cancelling");
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
        await enqueuePersistence(clearPersistedCleanupScan);
      } catch {
        // The in-memory map is visibly marked as stale even if disk cleanup fails.
      }
      return;
    }
    try {
      await enqueuePersistence(() => savePersistedCleanupScan(updated));
    } catch {
      // Never retain a pre-deletion map if the corrected snapshot cannot be saved.
      try {
        await enqueuePersistence(clearPersistedCleanupScan);
      } catch {
        // The in-memory result is still authoritative for this app session.
      }
    }
  }, [enqueuePersistence]);

  const retainSubtree = useCallback(async (subtree: CleanupNode) => {
    const current = snapshotRef.current;
    if (!current) return;
    const updated = retainCleanupSubtree(current, subtree);
    snapshotRef.current = updated;
    setSnapshot(updated);
    try {
      await enqueuePersistence(() => savePersistedCleanupScan(updated));
    } catch {
      // The in-memory subtree remains useful for this session if disk caching fails.
    }
  }, [enqueuePersistence]);

  const clear = useCallback(async () => {
    stateTouched.current = true;
    trackerRef.current += 1;
    if (activeJobIdRef.current) {
      try {
        await cancelCleanupScan();
      } catch {
        // Continue clearing cached state even if an active scan cannot be cancelled.
      }
    }
    activeJobIdRef.current = null;
    clearStoredCleanupScan();
    snapshotRef.current = null;
    setSnapshot(null);
    setSnapshotStatus("current");
    setError(null);
    setLoading(false);
    setCancelling(false);
    setProgress(null);
    setPhase(null);
    await enqueuePersistence(clearPersistedCleanupScan);
  }, [enqueuePersistence]);

  const growthComparison = useMemo(
    () => cleanupScanGrowthComparison(scanHistory.value, snapshot),
    [scanHistory.value, snapshot],
  );

  return {
    snapshot,
    snapshotStatus,
    error,
    loading,
    cancelling,
    phase,
    progress,
    scan,
    cancel,
    clear,
    applyDeletion,
    retainSubtree,
    growthComparison,
    scanHistoryStorageStatus: scanHistory.storageStatus,
  };
}
