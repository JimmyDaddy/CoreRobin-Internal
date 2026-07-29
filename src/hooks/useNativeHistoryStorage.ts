import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import {
  clearHistoryStorage,
  isDesktopRuntime,
  loadHistoryStorage,
  saveHistoryStorage,
  type HistorySegmentStorage,
  type HistoryStorageCategory,
} from "../api";
import { isProductDataResetInProgress } from "../productSupport";

export interface NativeHistoryStorageStatus {
  state: "loading" | "ready" | "failed";
  byteSize: number;
  lastSavedAtMs: number | null;
  error: string | null;
}

interface NativeHistoryStorageOptions<T> {
  category: HistoryStorageCategory;
  enabled: boolean;
  initialValue: () => T;
  parse: (payload: string | null) => T;
  serialize: (value: T) => string;
  clearLegacy?: () => void;
  flushDelayMs?: number;
}

export function useNativeHistoryStorage<T>({
  category,
  enabled,
  initialValue,
  parse,
  serialize,
  clearLegacy,
  flushDelayMs = 1_000,
}: NativeHistoryStorageOptions<T>): {
  value: T;
  setValue: Dispatch<SetStateAction<T>>;
  hydrated: boolean;
  storageStatus: NativeHistoryStorageStatus;
  clear: () => Promise<HistorySegmentStorage>;
  persistNow: () => Promise<void>;
} {
  const desktop = isDesktopRuntime();
  const [value, setValue] = useState(initialValue);
  const [hydrated, setHydrated] = useState(!desktop);
  const [storageStatus, setStorageStatus] =
    useState<NativeHistoryStorageStatus>({
      state: desktop ? "loading" : "ready",
      byteSize: 0,
      lastSavedAtMs: null,
      error: null,
    });
  const valueRef = useRef(value);
  const enabledRef = useRef(enabled);
  const lastSerializedRef = useRef(desktop ? "" : serialize(value));
  const saveInFlightRef = useRef<Promise<void> | null>(null);
  valueRef.current = value;
  enabledRef.current = enabled;

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void loadHistoryStorage(category)
      .then(async (stored) => {
        if (!active) return;
        const nativeValue = stored.payload === null
          ? null
          : parse(stored.payload);
        const legacyValue = initialValue();
        const next = nativeValue ?? legacyValue;
        const serialized = serialize(next);
        setValue(next);
        valueRef.current = next;
        lastSerializedRef.current = stored.payload ?? "";
        setHydrated(true);
        setStorageStatus({
          state: "ready",
          byteSize: stored.byteSize,
          lastSavedAtMs: stored.updatedAtMs,
          error: null,
        });
        if (stored.payload === null && serialized !== serialize(parse(null))) {
          const receipt = await saveHistoryStorage(category, serialized);
          clearLegacy?.();
          if (active) {
            lastSerializedRef.current = serialized;
            setStorageStatus({
              state: "ready",
              byteSize: receipt.byteSize,
              lastSavedAtMs: receipt.updatedAtMs,
              error: null,
            });
          }
        }
      })
      .catch((reason) => {
        if (!active) return;
        setHydrated(true);
        setStorageStatus({
          state: "failed",
          byteSize: 0,
          lastSavedAtMs: null,
          error: errorMessage(reason),
        });
      });
    return () => {
      active = false;
    };
  // The storage category and serializers are intentionally immutable per hook
  // instance. Re-hydrating on every render would overwrite newly sampled data.
  }, [category, desktop]);

  const persistNow = useCallback(async () => {
    if (!enabledRef.current || isProductDataResetInProgress()) return;
    const serialized = serialize(valueRef.current);
    if (serialized === lastSerializedRef.current) return;
    if (!desktop) {
      lastSerializedRef.current = serialized;
      return;
    }
    if (saveInFlightRef.current) {
      await saveInFlightRef.current;
      if (serialize(valueRef.current) === lastSerializedRef.current) return;
    }
    const request = saveHistoryStorage(category, serialized)
      .then((receipt) => {
        lastSerializedRef.current = serialized;
        setStorageStatus({
          state: "ready",
          byteSize: receipt.byteSize,
          lastSavedAtMs: receipt.updatedAtMs,
          error: null,
        });
      })
      .catch((reason) => {
        setStorageStatus((current) => ({
          ...current,
          state: "failed",
          error: errorMessage(reason),
        }));
        throw reason;
      })
      .finally(() => {
        if (saveInFlightRef.current === request) {
          saveInFlightRef.current = null;
        }
      });
    saveInFlightRef.current = request;
    await request;
  }, [category, desktop, serialize]);

  useEffect(() => {
    if (!hydrated || !enabled) return;
    const timer = window.setTimeout(() => {
      void persistNow().catch(() => undefined);
    }, flushDelayMs);
    return () => window.clearTimeout(timer);
  }, [enabled, flushDelayMs, hydrated, persistNow, value]);

  const clear = useCallback(async () => {
    clearLegacy?.();
    setValue(parse(null));
    valueRef.current = parse(null);
    lastSerializedRef.current = "";
    if (!desktop) {
      setStorageStatus({
        state: "ready",
        byteSize: 0,
        lastSavedAtMs: null,
        error: null,
      });
      return { payload: null, byteSize: 0, updatedAtMs: null };
    }
    try {
      const receipt = await clearHistoryStorage(category);
      setStorageStatus({
        state: "ready",
        byteSize: receipt.byteSize,
        lastSavedAtMs: receipt.updatedAtMs,
        error: null,
      });
      return receipt;
    } catch (reason) {
      setStorageStatus((current) => ({
        ...current,
        state: "failed",
        error: errorMessage(reason),
      }));
      throw reason;
    }
  }, [category, clearLegacy, desktop, parse]);

  return {
    value,
    setValue,
    hydrated,
    storageStatus,
    clear,
    persistNow,
  };
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
