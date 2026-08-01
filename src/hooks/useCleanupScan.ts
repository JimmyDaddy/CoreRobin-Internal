import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  applyCleanupIndexDeletions,
  cancelCleanupDirectoryRefresh,
  cancelCleanupScan,
  clearPersistedCleanupScan,
  getCleanupDirectoryRefreshJob,
  getCleanupScanJob,
  loadCleanupDirectoryRefreshResult,
  loadPersistedCleanupScan,
  loadCleanupScanJobResult,
  startCleanupDirectoryRefresh,
  startCleanupScan,
} from "../api";
import {
  reconcileCleanupScanAfterDeletion,
  type CleanupDeletionTargetSnapshot,
  type CleanupSnapshotStatus,
} from "../cleanupScanStore";
import type {
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
  const activeRefreshJobIdRef = useRef<string | null>(null);
  const trackerRef = useRef(0);
  const refreshTrackerRef = useRef(0);
  const stateTouched = useRef(false);
  const snapshotRef = useRef<CleanupScan | null>(null);
  const snapshotSyncRef = useRef<Promise<CleanupScan | null> | null>(null);
  const [refreshStatus, setRefreshStatus] = useState<CleanupScanJobStatus | null>(null);
  const [refreshError, setRefreshError] = useState<CommandError | null>(null);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    let disposed = false;
    void loadPersistedCleanupScan()
      .then((persisted) => {
        if (disposed || stateTouched.current || !persisted) return;
        snapshotRef.current = persisted;
        setSnapshot(persisted);
        setSnapshotStatus("current");
      })
      .catch(() => {
        // A missing or unavailable disk cache is equivalent to no prior scan.
      });
    return () => {
      disposed = true;
    };
  }, []);

  const reloadLatestSnapshot = useCallback((): Promise<CleanupScan | null> => {
    if (snapshotSyncRef.current) return snapshotSyncRef.current;
    const sync = (async () => {
      const job = await getCleanupScanJob().catch(() => null);
      if (job && (
        job.phase === "preparing"
        || job.phase === "scanning"
        || job.phase === "paused"
        || job.phase === "cancelling"
        || job.phase === "stalled"
      )) {
        return snapshotRef.current;
      }
      const persisted = await loadPersistedCleanupScan();
      if (!persisted) return null;
      const current = snapshotRef.current;
      if (
        !current
        || persisted.scanId !== current.scanId
        || persisted.sampledAtMs > current.sampledAtMs
      ) {
        snapshotRef.current = persisted;
        setSnapshot(persisted);
        setSnapshotStatus("current");
        setError(null);
        scanHistory.setValue((history) =>
          appendCleanupScanSnapshot(history, persisted));
      }
      return persisted;
    })().finally(() => {
      snapshotSyncRef.current = null;
    });
    snapshotSyncRef.current = sync;
    return sync;
  }, [scanHistory.setValue]);

  useEffect(() => {
    const reconcileWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void reloadLatestSnapshot().catch(() => {
          // The existing result stays usable if the native cache is briefly busy.
        });
      }
    };
    window.addEventListener("focus", reconcileWhenVisible);
    document.addEventListener("visibilitychange", reconcileWhenVisible);
    return () => {
      window.removeEventListener("focus", reconcileWhenVisible);
      document.removeEventListener("visibilitychange", reconcileWhenVisible);
    };
  }, [reloadLatestSnapshot]);

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

  const followDirectoryRefresh = useCallback(async (
    initialStatus: CleanupScanJobStatus,
    tracker: number,
  ) => {
    let status: CleanupScanJobStatus | null = initialStatus;
    activeRefreshJobIdRef.current = initialStatus.jobId;
    while (
      status
      && refreshTrackerRef.current === tracker
      && activeRefreshJobIdRef.current === initialStatus.jobId
    ) {
      setRefreshStatus(status);
      if (status.phase === "completed") {
        try {
          const completed = await loadCleanupDirectoryRefreshResult(status.jobId);
          if (refreshTrackerRef.current !== tracker) return;
          snapshotRef.current = completed;
          setSnapshot(completed);
          setSnapshotStatus("current");
          setRefreshError(null);
        } catch (caughtError) {
          if (refreshTrackerRef.current === tracker) {
            setRefreshError(normalizeCommandError(caughtError));
          }
        }
        activeRefreshJobIdRef.current = null;
        return;
      }
      if (status.phase === "cancelled") {
        activeRefreshJobIdRef.current = null;
        return;
      }
      if (status.phase === "failed") {
        activeRefreshJobIdRef.current = null;
        setRefreshError({
          code: status.errorCode ?? "cleanup_refresh_failed",
          message: status.errorMessage ?? "The folder refresh worker stopped unexpectedly.",
        });
        return;
      }
      await waitForCleanupJobPoll();
      if (refreshTrackerRef.current !== tracker) return;
      try {
        status = await getCleanupDirectoryRefreshJob();
      } catch (caughtError) {
        if (refreshTrackerRef.current === tracker) {
          activeRefreshJobIdRef.current = null;
          setRefreshError(normalizeCommandError(caughtError));
        }
        return;
      }
      if (status && status.jobId !== initialStatus.jobId) return;
    }
  }, []);

  useEffect(() => {
    const tracker = ++refreshTrackerRef.current;
    void getCleanupDirectoryRefreshJob()
      .then((status) => {
        if (!status || refreshTrackerRef.current !== tracker) return;
        void followDirectoryRefresh(status, tracker);
      })
      .catch(() => {
        // No native refresh job is the normal idle state.
      });
    return () => {
      refreshTrackerRef.current += 1;
    };
  }, [followDirectoryRefresh]);

  const refreshDirectory = useCallback(async (directoryId: string) => {
    const current = snapshotRef.current;
    if (!current?.scanId) return;
    const tracker = ++refreshTrackerRef.current;
    setRefreshError(null);
    try {
      const job = await startCleanupDirectoryRefresh({
        scanId: current.scanId,
        directoryId,
      });
      if (refreshTrackerRef.current !== tracker) return;
      setRefreshStatus(job);
      void followDirectoryRefresh(job, tracker);
    } catch (caughtError) {
      if (refreshTrackerRef.current === tracker) {
        setRefreshError(normalizeCommandError(caughtError));
      }
    }
  }, [followDirectoryRefresh]);

  const cancelDirectoryRefresh = useCallback(async () => {
    if (!activeRefreshJobIdRef.current) return;
    try {
      await cancelCleanupDirectoryRefresh();
    } catch (caughtError) {
      setRefreshError(normalizeCommandError(caughtError));
    }
  }, []);

  const scan = useCallback(async (
    target: CleanupScanTarget = {
      profile: "common_locations",
      targetKind: "system_disk",
      targetPath: null,
    },
  ) => {
    const tracker = ++trackerRef.current;
    stateTouched.current = true;
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
  }, [followJob]);

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
    const indexedNodeIds = targets
      .map((target) => target.id)
      .filter((id): id is string => Boolean(id?.startsWith(`index:${current.scanId}:`)));
    const updated = indexedNodeIds.length > 0 && current.indexed
      ? await applyCleanupIndexDeletions({
          scanId: current.scanId,
          nodeIds: indexedNodeIds,
        })
      : targets.length > 0
        ? reconcileCleanupScanAfterDeletion(current, targets)
        : current;
    snapshotRef.current = updated;
    setSnapshot(updated);
    if (invalidateSnapshot) {
      setSnapshotStatus("expired");
      return;
    }
  }, []);

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
    refreshTrackerRef.current += 1;
    if (activeRefreshJobIdRef.current) {
      try {
        await cancelCleanupDirectoryRefresh();
      } catch {
        // The native clear command still terminates any remaining refresh worker.
      }
    }
    activeJobIdRef.current = null;
    activeRefreshJobIdRef.current = null;
    snapshotRef.current = null;
    setSnapshot(null);
    setSnapshotStatus("current");
    setError(null);
    setLoading(false);
    setCancelling(false);
    setProgress(null);
    setPhase(null);
    setRefreshStatus(null);
    setRefreshError(null);
    await clearPersistedCleanupScan();
  }, []);

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
    growthComparison,
    scanHistoryStorageStatus: scanHistory.storageStatus,
    refreshDirectory,
    reloadLatestSnapshot,
    cancelDirectoryRefresh,
    directoryRefreshStatus: refreshStatus,
    directoryRefreshError: refreshError,
  };
}
