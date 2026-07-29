import { useCallback, useEffect, useMemo, useState } from "react";

import {
  clearApplicationInventoryCache,
  getProductDataCacheSummary,
  type ProductDataCacheSummary,
} from "../api";
import { RESOURCE_ALERT_STORAGE_KEY } from "../alertStore";
import { APPLICATION_WATCH_HISTORY_STORAGE_KEY } from "../applicationWatchHistory";
import { CONNECTION_HISTORY_STORAGE_KEY } from "../connectionHistory";
import { PERSISTENT_HISTORY_STORAGE_KEY } from "../historyStore";
import { NETWORK_QUALITY_HISTORY_STORAGE_KEY } from "../networkQualityHistory";
import { USER_ACTION_HISTORY_STORAGE_KEY } from "../userActionHistory";

export const PRODUCT_DATA_CATEGORIES = [
  "resourceHistory",
  "connectionHistory",
  "applicationInventory",
  "scanCaches",
] as const;

export type ProductDataCategory = (typeof PRODUCT_DATA_CATEGORIES)[number];
export type ProductDataClearStatus = "idle" | "clearing" | "succeeded" | "failed";

export interface ProductDataCategorySummary {
  byteSize: number;
  itemCount: number;
  updatedAtMs: number | null;
  retentionDays: number | null;
}

export interface ProductDataClearReceipt {
  status: ProductDataClearStatus;
  completedAtMs: number | null;
  error: string | null;
}

export type ProductDataClearReceipts = Record<
  ProductDataCategory,
  ProductDataClearReceipt
>;

interface ProductDataPrivacyInput {
  resourceItemCount: number;
  resourceUpdatedAtMs: number | null;
  resourceRetentionDays: number;
  connectionItemCount: number;
  connectionUpdatedAtMs: number | null;
  connectionRetentionDays: number;
  networkQualityItemCount: number;
  networkQualityUpdatedAtMs: number | null;
  cleanupItemCount: number;
  cleanupUpdatedAtMs: number | null;
  fileInsightsItemCount: number;
  fileInsightsUpdatedAtMs: number | null;
  onClearResourceHistory: () => void;
  onClearConnectionHistory: () => void;
  onClearCleanupScan: () => Promise<void>;
  onClearFileInsights: () => Promise<void>;
}

const EMPTY_CACHE_SUMMARY: ProductDataCacheSummary = {
  cleanupScan: { byteSize: 0, fileCount: 0, updatedAtMs: null },
  fileInsights: { byteSize: 0, fileCount: 0, updatedAtMs: null },
  applicationInventory: { byteSize: 0, fileCount: 0, updatedAtMs: null },
  applicationHistory: { byteSize: 0, fileCount: 0, updatedAtMs: null },
  historySegments: { byteSize: 0, fileCount: 0, updatedAtMs: null },
};

const EMPTY_RECEIPT: ProductDataClearReceipt = {
  status: "idle",
  completedAtMs: null,
  error: null,
};

function initialReceipts(): ProductDataClearReceipts {
  return {
    resourceHistory: { ...EMPTY_RECEIPT },
    connectionHistory: { ...EMPTY_RECEIPT },
    applicationInventory: { ...EMPTY_RECEIPT },
    scanCaches: { ...EMPTY_RECEIPT },
  };
}

function storageByteSize(keys: readonly string[]): number {
  try {
    return keys.reduce((total, key) => {
      const value = window.localStorage.getItem(key);
      return total + (value ? new TextEncoder().encode(value).byteLength : 0);
    }, 0);
  } catch {
    return 0;
  }
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  return String(reason);
}

export function useProductDataPrivacy(input: ProductDataPrivacyInput) {
  const [cacheSummary, setCacheSummary] =
    useState<ProductDataCacheSummary>(EMPTY_CACHE_SUMMARY);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<ProductDataClearReceipts>(
    initialReceipts,
  );
  const [storageRevision, setStorageRevision] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const summary = await getProductDataCacheSummary();
      setCacheSummary({
        ...EMPTY_CACHE_SUMMARY,
        ...summary,
        historySegments:
          summary.historySegments ?? EMPTY_CACHE_SUMMARY.historySegments,
      });
      setSummaryError(null);
    } catch (reason) {
      setSummaryError(errorMessage(reason));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const clearCategory = useCallback(async (category: ProductDataCategory) => {
    setReceipts((current) => ({
      ...current,
      [category]: {
        status: "clearing",
        completedAtMs: null,
        error: null,
      },
    }));
    try {
      switch (category) {
        case "resourceHistory":
          input.onClearResourceHistory();
          break;
        case "connectionHistory":
          input.onClearConnectionHistory();
          break;
        case "applicationInventory":
          await clearApplicationInventoryCache();
          break;
        case "scanCaches": {
          const results = await Promise.allSettled([
            input.onClearCleanupScan(),
            input.onClearFileInsights(),
          ]);
          const failed = results.filter((result) => result.status === "rejected");
          if (failed.length > 0) {
            throw new Error(`scan_cache_clear_incomplete:${failed.length}`);
          }
          break;
        }
      }
      setStorageRevision((current) => current + 1);
      await refresh();
      setReceipts((current) => ({
        ...current,
        [category]: {
          status: "succeeded",
          completedAtMs: Date.now(),
          error: null,
        },
      }));
      return true;
    } catch (reason) {
      setReceipts((current) => ({
        ...current,
        [category]: {
          status: "failed",
          completedAtMs: Date.now(),
          error: errorMessage(reason),
        },
      }));
      return false;
    }
  }, [input, refresh]);

  const categories = useMemo<Record<ProductDataCategory, ProductDataCategorySummary>>(
    () => ({
      resourceHistory: {
        byteSize:
          storageByteSize([
            PERSISTENT_HISTORY_STORAGE_KEY,
            RESOURCE_ALERT_STORAGE_KEY,
            APPLICATION_WATCH_HISTORY_STORAGE_KEY,
            USER_ACTION_HISTORY_STORAGE_KEY,
          ])
          + cacheSummary.applicationHistory.byteSize
          + cacheSummary.historySegments.byteSize,
        itemCount: input.resourceItemCount,
        updatedAtMs: Math.max(
          input.resourceUpdatedAtMs ?? 0,
          cacheSummary.applicationHistory.updatedAtMs ?? 0,
          cacheSummary.historySegments.updatedAtMs ?? 0,
        ) || null,
        retentionDays: input.resourceRetentionDays,
      },
      connectionHistory: {
        byteSize: storageByteSize([
          CONNECTION_HISTORY_STORAGE_KEY,
          NETWORK_QUALITY_HISTORY_STORAGE_KEY,
        ]),
        itemCount:
          input.connectionItemCount + input.networkQualityItemCount,
        updatedAtMs: Math.max(
          input.connectionUpdatedAtMs ?? 0,
          input.networkQualityUpdatedAtMs ?? 0,
        ) || null,
        retentionDays: input.connectionRetentionDays,
      },
      applicationInventory: {
        byteSize: cacheSummary.applicationInventory.byteSize,
        itemCount: cacheSummary.applicationInventory.fileCount,
        updatedAtMs: cacheSummary.applicationInventory.updatedAtMs,
        retentionDays: 7,
      },
      scanCaches: {
        byteSize:
          cacheSummary.cleanupScan.byteSize + cacheSummary.fileInsights.byteSize,
        itemCount: input.cleanupItemCount + input.fileInsightsItemCount,
        updatedAtMs: Math.max(
          input.cleanupUpdatedAtMs ?? 0,
          input.fileInsightsUpdatedAtMs ?? 0,
          cacheSummary.cleanupScan.updatedAtMs ?? 0,
          cacheSummary.fileInsights.updatedAtMs ?? 0,
        ) || null,
        retentionDays: 7,
      },
    }),
    [cacheSummary, input, storageRevision],
  );

  return {
    categories,
    receipts,
    summaryError,
    clearCategory,
    refresh,
  };
}

export type ProductDataPrivacyController = ReturnType<
  typeof useProductDataPrivacy
>;
