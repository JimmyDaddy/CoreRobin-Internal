import { useCallback, useEffect, useRef, useState } from "react";

import {
  cancelFileInsightsScan,
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

  useEffect(() => {
    let disposed = false;
    void loadPersistedFileInsightsScan()
      .then((serialized) => {
        const persisted = parseStoredFileInsightsScan(serialized);
        if (serialized && !persisted) {
          void clearPersistedFileInsightsScan().catch(() => undefined);
        }
        return persisted;
      })
      .then((persisted) => {
        if (disposed || stateTouched.current || !persisted) return;
        snapshotRef.current = persisted.snapshot;
        setSnapshot(persisted.snapshot);
        setSnapshotStatus(persisted.status);
      })
      .catch(() => {
        // An unavailable cache behaves like a first visit to the workspace.
      });
    return () => {
      disposed = true;
    };
  }, []);

  const scan = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    stateTouched.current = true;
    setLoading(true);
    setError(null);
    setProgress(null);
    try {
      const completed = await scanFileInsights(setProgress);
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
      if (commandError.code !== "file_insights_scan_cancelled") {
        setError(commandError.message);
      }
    } finally {
      inFlight.current = false;
      setLoading(false);
      setProgress(null);
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

  return {
    snapshot,
    snapshotStatus,
    progress,
    loading,
    error,
    scan,
    cancel,
    removePaths,
  };
}
