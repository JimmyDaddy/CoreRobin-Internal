import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelFileInsightsScan,
  revalidateFileInsightsScan,
  scanFileInsights,
} from "../api";
import {
  clearPersistedFileInsightsScan,
  loadPersistedFileInsightsScan,
  savePersistedFileInsightsScan,
} from "../fileInsightsPersistence";
import {
  parseStoredFileInsightsScan,
  reconcileFileInsightsAfterDeletion,
  type FileInsightsSnapshotStatus,
} from "../fileInsightsStore";
import type { FileInsightsProgress, FileInsightsScan } from "../types";
import { normalizeCommandError } from "../utils";

export function useFileInsightsScan() {
  const [snapshot, setSnapshot] = useState<FileInsightsScan | null>(null);
  const [snapshotStatus, setSnapshotStatus] = useState<FileInsightsSnapshotStatus>("current");
  const [progress, setProgress] = useState<FileInsightsProgress | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshotRef = useRef<FileInsightsScan | null>(null);
  const inFlight = useRef(false);
  const stateTouched = useRef(false);
  const epoch = useRef(0);

  useEffect(() => {
    let disposed = false;
    void loadPersistedFileInsightsScan()
      .then((serialized) => {
        const persisted = parseStoredFileInsightsScan(serialized);
        if (!disposed && !stateTouched.current && serialized && !persisted) {
          void clearPersistedFileInsightsScan().catch(() => undefined);
        }
        return persisted;
      })
      .then(async (persisted) => {
        if (disposed || stateTouched.current || !persisted) return;
        let verified = persisted.snapshot;
        try {
          verified = await revalidateFileInsightsScan(persisted.snapshot);
          if (disposed || stateTouched.current) return;
          await savePersistedFileInsightsScan(verified);
        } catch {
          // The bounded cached result remains available if revalidation is unavailable.
        }
        if (disposed || stateTouched.current) return;
        snapshotRef.current = verified;
        setSnapshot(verified);
        setSnapshotStatus(persisted.status);
      })
      .catch(() => {
        // An unavailable cache behaves like a first visit to the workspace.
      });
    return () => {
      disposed = true;
      ++epoch.current;
    };
  }, []);

  const scan = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    stateTouched.current = true;
    const generation = epoch.current;
    setLoading(true);
    setError(null);
    setProgress(null);
    try {
      const completed = await scanFileInsights((value) => {
        if (epoch.current === generation) setProgress(value);
      });
      if (epoch.current !== generation) return;
      snapshotRef.current = completed;
      setSnapshot(completed);
      setSnapshotStatus("current");
      try {
        await savePersistedFileInsightsScan(completed);
      } catch {
        // The live result remains usable even when persistence is unavailable.
      }
    } catch (reason) {
      const commandError = normalizeCommandError(reason);
      if (epoch.current === generation && commandError.code !== "file_insights_scan_cancelled") {
        setError(commandError.message);
      }
    } finally {
      inFlight.current = false;
      if (epoch.current === generation) { setLoading(false); setProgress(null); }
    }
  }, []);

  const cancel = useCallback(async () => {
    if (!inFlight.current) return;
    try {
      await cancelFileInsightsScan();
    } catch (reason) {
      setError(normalizeCommandError(reason).message);
    }
  }, []);

  const removePaths = useCallback((paths: readonly string[]) => {
    const current = snapshotRef.current;
    if (!current || paths.length === 0) return;
    const updated = reconcileFileInsightsAfterDeletion(current, paths);
    snapshotRef.current = updated;
    setSnapshot(updated);
    void savePersistedFileInsightsScan(updated).catch(() => {
      // In-memory reconciliation is still authoritative for this session.
    });
  }, []);

  const clear = useCallback(async () => {
    stateTouched.current = true;
    ++epoch.current;
    snapshotRef.current = null;
    setSnapshot(null);
    setSnapshotStatus("current");
    setProgress(null);
    setLoading(false);
    setError(null);
    // A cancellation failure must not skip clearing the existing cache. The
    // generation still rejects late progress, results and persistence writes.
    if (inFlight.current) await cancelFileInsightsScan().catch(() => {});
    await clearPersistedFileInsightsScan();
  }, []);

  return {
    snapshot,
    snapshotStatus,
    progress,
    loading,
    error,
    scan,
    cancel,
    clear,
    removePaths,
  };
}

export type FileInsightsScanController = ReturnType<typeof useFileInsightsScan>;
