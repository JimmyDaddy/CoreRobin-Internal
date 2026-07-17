import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";

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

export async function checkForInstallableAppUpdate(): Promise<InstallableAppUpdate | null> {
  const update = await check({ timeout: 15_000 });
  return update ? wrapUpdate(update) : null;
}

export async function restartAfterAppUpdate(): Promise<void> {
  await relaunch();
}

function wrapUpdate(update: Update): InstallableAppUpdate {
  return {
    version: update.version,
    notes: update.body?.trim() || null,
    install: async (onProgress) => {
      let downloadedBytes = 0;
      let contentLength: number | null = null;
      await update.downloadAndInstall((event) => {
        const progress = progressFromEvent(event, downloadedBytes, contentLength);
        downloadedBytes = progress.downloadedBytes;
        contentLength = progress.contentLength;
        onProgress(progress);
      });
    },
    close: () => update.close(),
  };
}

function progressFromEvent(
  event: DownloadEvent,
  downloadedBytes: number,
  contentLength: number | null,
): AppUpdateProgress {
  if (event.event === "Started") {
    const total = event.data.contentLength ?? null;
    return progress("downloading", 0, total);
  }
  if (event.event === "Progress") {
    return progress("downloading", downloadedBytes + event.data.chunkLength, contentLength);
  }
  return progress("installing", downloadedBytes, contentLength);
}

function progress(
  phase: AppUpdateProgress["phase"],
  downloadedBytes: number,
  contentLength: number | null,
): AppUpdateProgress {
  return {
    phase,
    downloadedBytes,
    contentLength,
    percent: contentLength && contentLength > 0
      ? Math.min(100, Math.round((downloadedBytes / contentLength) * 100))
      : null,
  };
}
