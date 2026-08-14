import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

const UPDATE_TASK_POLL_INTERVAL_MS = 500;
const UPDATE_TASK_QUERY_RETRY_DELAYS_MS = [750, 1_500, 3_000, 5_000, 10_000];

export interface AppUpdateProgress {
  phase: "downloading" | "installing";
  downloadedBytes: number;
  contentLength: number | null;
  percent: number | null;
}

export interface InstallableAppUpdate {
  version: string;
  notes: string | null;
  install: (onProgress: (progress: AppUpdateProgress) => void) => Promise<void>;
  close: () => Promise<void>;
}

export type AppUpdateTaskPhase =
  | "idle"
  | "downloading"
  | "installing"
  | "ready"
  | "failed";

export interface AppUpdateTaskSnapshot {
  version: string | null;
  phase: AppUpdateTaskPhase;
  downloadedBytes: number;
  contentLength: number | null;
  updatedAtMs: number;
}

export async function checkForInstallableAppUpdate(): Promise<InstallableAppUpdate | null> {
  const update = await check({ timeout: 15_000 });
  return update ? wrapUpdate(update) : null;
}

export async function restartAfterAppUpdate(): Promise<void> {
  await relaunch();
}

export async function getAppUpdateTask(): Promise<AppUpdateTaskSnapshot> {
  return invoke<AppUpdateTaskSnapshot>("get_app_update_task");
}

function wrapUpdate(update: Update): InstallableAppUpdate {
  return {
    version: update.version,
    notes: update.body?.trim() || null,
    install: (onProgress) =>
      installAppUpdate(update.version, onProgress),
    close: () => update.close(),
  };
}

async function installAppUpdate(
  version: string,
  onProgress: (progress: AppUpdateProgress) => void,
): Promise<void> {
  let snapshot = await invoke<AppUpdateTaskSnapshot>("start_app_update", {
    version,
  });
  let queryFailureCount = 0;
  while (true) {
    if (snapshot.version !== version) {
      throw new Error("The active app update changed.");
    }
    onProgress(progressFromSnapshot(snapshot));
    if (snapshot.phase === "ready") return;
    if (snapshot.phase === "failed" || snapshot.phase === "idle") {
      throw new Error("The app update task did not complete.");
    }
    await delay(UPDATE_TASK_POLL_INTERVAL_MS);
    try {
      snapshot = await getAppUpdateTask();
      queryFailureCount = 0;
    } catch (reason) {
      const retryDelay = UPDATE_TASK_QUERY_RETRY_DELAYS_MS[
        Math.min(queryFailureCount, UPDATE_TASK_QUERY_RETRY_DELAYS_MS.length - 1)
      ];
      queryFailureCount += 1;
      if (queryFailureCount > UPDATE_TASK_QUERY_RETRY_DELAYS_MS.length) throw reason;
      await delay(retryDelay);
    }
  }
}

export function progressFromSnapshot(
  snapshot: AppUpdateTaskSnapshot,
): AppUpdateProgress {
  const contentLength = snapshot.contentLength;
  return {
    phase: snapshot.phase === "installing" || snapshot.phase === "ready"
      ? "installing"
      : "downloading",
    downloadedBytes: snapshot.downloadedBytes,
    contentLength,
    percent: contentLength && contentLength > 0
      ? Math.min(
          100,
          Math.round((snapshot.downloadedBytes / contentLength) * 100),
        )
      : null,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
