import { useCallback, useEffect, useRef, useState } from "react";

import { isDesktopRuntime, runNetworkQualityCheck } from "../api";
import {
  clearNetworkQualityHistory,
  loadNetworkQualityHistory,
  mergeNetworkQualityHistory,
  parseNetworkQualityHistory,
  saveNetworkQualityHistory,
  serializeNetworkQualityHistory,
  type NetworkQualityHistoryHours,
} from "../networkQualityHistory";
import type { NetworkQualityResult } from "../types";
import { normalizeCommandError } from "../utils";
import { useNativeHistoryStorage } from "./useNativeHistoryStorage";

export const NETWORK_QUALITY_REFRESH_MS = 30 * 1_000;
export const NETWORK_QUALITY_BACKGROUND_REFRESH_MS = 5 * 60 * 1_000;
export const NETWORK_QUALITY_WINDOW_MS = 15 * 60 * 1_000;
const NETWORK_QUALITY_MAX_POINTS =
  NETWORK_QUALITY_WINDOW_MS / NETWORK_QUALITY_REFRESH_MS + 1;

export function appendNetworkQualitySample(
  samples: readonly NetworkQualityResult[],
  sample: NetworkQualityResult,
): NetworkQualityResult[] {
  const cutoff = sample.sampledAtMs - NETWORK_QUALITY_WINDOW_MS;
  return samples
    .filter((candidate) =>
      candidate.sampledAtMs >= cutoff
      && candidate.sampledAtMs !== sample.sampledAtMs)
    .concat(sample)
    .sort((left, right) => left.sampledAtMs - right.sampledAtMs)
    .slice(-NETWORK_QUALITY_MAX_POINTS);
}

export function useNetworkQualityMonitor({
  active,
  historyEnabled,
  historyHours,
  networkSignature = "",
}: {
  active: boolean;
  historyEnabled: boolean;
  historyHours: NetworkQualityHistoryHours;
  networkSignature?: string;
}) {
  const [result, setResult] = useState<NetworkQualityResult | null>(null);
  const [sessionSamples, setSessionSamples] =
    useState<NetworkQualityResult[]>([]);
  const desktop = isDesktopRuntime();
  const historyStorage = useNativeHistoryStorage({
    category: "network-quality",
    enabled: historyEnabled,
    initialValue: loadNetworkQualityHistory,
    parse: parseNetworkQualityHistory,
    serialize: serializeNetworkQualityHistory,
    clearLegacy: clearNetworkQualityHistory,
  });
  const storedHistory = historyStorage.value;
  const setHistory = historyStorage.setValue;
  const history = historyEnabled ? storedHistory : [];
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const checkingRef = useRef(false);
  const latestSampledAtRef = useRef(0);
  const mountedRef = useRef(true);
  const historyEnabledRef = useRef(historyEnabled);
  const historyHoursRef = useRef(historyHours);
  const networkSignatureRef = useRef(networkSignature);

  historyEnabledRef.current = historyEnabled;
  historyHoursRef.current = historyHours;
  networkSignatureRef.current = networkSignature;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!historyEnabled) {
      return;
    }
    const cutoff = Date.now() - historyHours * 60 * 60 * 1_000;
    const loaded = storedHistory
      .filter((point) => point.sampledAtMs >= cutoff);
    if (!desktop) saveNetworkQualityHistory(loaded);
    setHistory(loaded);
  }, [desktop, historyEnabled, historyHours]);

  const runCheck = useCallback(async () => {
    if (checkingRef.current) return false;
    checkingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const nextResult = await runNetworkQualityCheck();
      if (!mountedRef.current) return false;
      latestSampledAtRef.current = nextResult.sampledAtMs;
      setResult(nextResult);
      setSessionSamples((current) =>
        appendNetworkQualitySample(current, nextResult));
      if (historyEnabledRef.current) {
        setHistory((current) => {
          const next = mergeNetworkQualityHistory(
            current,
            nextResult,
            historyHoursRef.current,
            nextResult.sampledAtMs,
            networkSignatureRef.current,
          );
          if (!desktop) saveNetworkQualityHistory(next);
          return next;
        });
      }
      return true;
    } catch (reason) {
      if (mountedRef.current) {
        setError(normalizeCommandError(reason).message);
      }
      return false;
    } finally {
      checkingRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active && !historyEnabled) return;
    const intervalMs = active
      ? NETWORK_QUALITY_REFRESH_MS
      : NETWORK_QUALITY_BACKGROUND_REFRESH_MS;
    const latestAt = latestSampledAtRef.current;
    if (active || Date.now() - latestAt >= intervalMs) {
      void runCheck();
    }
    const interval = window.setInterval(() => void runCheck(), intervalMs);
    return () => window.clearInterval(interval);
  }, [active, historyEnabled, runCheck]);

  const clearHistory = useCallback(() => {
    void historyStorage.clear().catch(() => undefined);
  }, [historyStorage]);

  return {
    result,
    sessionSamples,
    history,
    loading,
    error,
    runCheck,
    clearHistory,
    storageStatus: historyStorage.storageStatus,
  };
}

export type NetworkQualityMonitorController = ReturnType<
  typeof useNetworkQualityMonitor
>;
