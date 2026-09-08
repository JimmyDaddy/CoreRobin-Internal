import { invoke } from "@tauri-apps/api/core";

import type { FileInsightsScan } from "./types";

// Only the main window can write this cache. Serialize saves and clears so a
// previously issued save cannot restore data after a successful clear.
let pendingWrites: Promise<unknown> = Promise.resolve();
function serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
  const pending = pendingWrites.then(operation, operation);
  pendingWrites = pending.catch(() => {});
  return pending;
}

const DEV_FILE_INSIGHTS_CACHE_KEY = "core-robin.dev-file-insights-cache.v1";

function canUseDevelopmentMock(): boolean {
  return import.meta.env.DEV
    && (typeof window === "undefined" || window.__TAURI_INTERNALS__ === undefined);
}

export async function loadPersistedFileInsightsScan(): Promise<string | null> {
  await pendingWrites;
  if (canUseDevelopmentMock()) {
    try {
      return window.localStorage.getItem(DEV_FILE_INSIGHTS_CACHE_KEY);
    } catch {
      return null;
    }
  }
  return invoke<string | null>("load_persisted_file_insights_scan");
}

async function saveSnapshot(
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

async function clearSnapshot(): Promise<void> {
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

export function savePersistedFileInsightsScan(snapshot: FileInsightsScan): Promise<void> {
  return serializeWrite(() => saveSnapshot(snapshot));
}
export function clearPersistedFileInsightsScan(): Promise<void> {
  return serializeWrite(clearSnapshot);
}
