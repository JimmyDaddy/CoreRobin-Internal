import { invoke } from "@tauri-apps/api/core";

import type { FileInsightsScan } from "./types";

const DEV_FILE_INSIGHTS_CACHE_KEY = "core-robin.dev-file-insights-cache.v1";

function canUseDevelopmentMock(): boolean {
  return import.meta.env.DEV
    && (typeof window === "undefined" || window.__TAURI_INTERNALS__ === undefined);
}

export async function loadPersistedFileInsightsScan(): Promise<string | null> {
  if (canUseDevelopmentMock()) {
    try {
      return window.localStorage.getItem(DEV_FILE_INSIGHTS_CACHE_KEY);
    } catch {
      return null;
    }
  }
  return invoke<string | null>("load_persisted_file_insights_scan");
}

export async function savePersistedFileInsightsScan(
  snapshot: FileInsightsScan,
): Promise<void> {
  if (canUseDevelopmentMock()) {
    window.localStorage.setItem(DEV_FILE_INSIGHTS_CACHE_KEY, JSON.stringify({
      version: 1,
      savedAtMs: Date.now(),
      snapshot,
    }));
    return;
  }
  return invoke<void>("save_persisted_file_insights_scan", { snapshot });
}

export async function clearPersistedFileInsightsScan(): Promise<void> {
  if (canUseDevelopmentMock()) {
    try {
      window.localStorage.removeItem(DEV_FILE_INSIGHTS_CACHE_KEY);
    } catch {
      // Development persistence is optional.
    }
    return;
  }
  return invoke<void>("clear_persisted_file_insights_scan");
}
