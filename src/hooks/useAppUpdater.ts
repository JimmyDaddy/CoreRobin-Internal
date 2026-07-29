import { useCallback, useEffect, useRef, useState } from "react";

import type {
  AppUpdateProgress,
  InstallableAppUpdate,
} from "../appUpdater";
import { isDesktopRuntime } from "../api";
import {
  checkForProductUpdate,
  CURRENT_APP_VERSION,
  type UpdateCheckResult,
} from "../productSupport";
import {
  loadAvailableUpdateVersion,
  saveAvailableUpdateVersion,
} from "../updateAvailability";

const UPDATE_CHECKED_AT_STORAGE_KEY =
  "core-robin.update-check.checked-at.v1";
const UPDATE_SKIPPED_VERSION_STORAGE_KEY =
  "core-robin.update-check.skipped-version.v1";
const UPDATE_INSTALLED_VERSION_STORAGE_KEY =
  "core-robin.update.installed-version.v1";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type AppUpdateAction =
  | "idle"
  | "installing"
  | "ready"
  | "restarting"
  | "installError"
  | "restartError";

export type AppUpdateDisplayResult =
  | Pick<UpdateCheckResult, "status" | "latestVersion">
  | "error"
  | null;

export interface AppUpdaterController {
  checking: boolean;
  result: AppUpdateDisplayResult;
  installableUpdate: InstallableAppUpdate | null;
  progress: AppUpdateProgress | null;
  action: AppUpdateAction;
  availableVersion: string | null;
  lastCheckedAt: number | null;
  lastCheckFailed: boolean;
  updatedFromVersion: string | null;
  check: (manual?: boolean) => Promise<void>;
  install: () => Promise<void>;
  restart: () => Promise<void>;
  skipAvailableVersion: () => void;
  dismissUpdatedReceipt: () => void;
}

export function useAppUpdater({
  onOperationStart,
  onOperationComplete,
}: {
  onOperationStart?: (version: string) => string;
  onOperationComplete?: (
    id: string,
    status: "succeeded" | "failed",
  ) => void;
} = {}): AppUpdaterController {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<AppUpdateDisplayResult>(null);
  const [installableUpdate, setInstallableUpdate] =
    useState<InstallableAppUpdate | null>(null);
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null);
  const [action, setAction] = useState<AppUpdateAction>("idle");
  const [availableVersion, setAvailableVersion] = useState<string | null>(
    loadAvailableUpdateVersion,
  );
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(
    () => readTimestamp(UPDATE_CHECKED_AT_STORAGE_KEY),
  );
  const [lastCheckFailed, setLastCheckFailed] = useState(false);
  const [updatedFromVersion, setUpdatedFromVersion] = useState<string | null>(
    detectUpdatedFromVersion,
  );
  const operationIdRef = useRef<string | null>(null);
  const currentUpdateRef = useRef<InstallableAppUpdate | null>(null);
  currentUpdateRef.current = installableUpdate;

  const replaceInstallable = useCallback(
    async (next: InstallableAppUpdate | null) => {
      const previous = currentUpdateRef.current;
      currentUpdateRef.current = next;
      setInstallableUpdate(next);
      if (previous && previous !== next) {
        await previous.close().catch(() => undefined);
      }
    },
    [],
  );

  const check = useCallback(async (manual = true) => {
    if (checking || action === "installing" || action === "restarting") return;
    setChecking(true);
    if (manual) setResult(null);
    if (action === "installError") setAction("idle");
    try {
      let nextResult: Exclude<AppUpdateDisplayResult, "error" | null>;
      if (isDesktopRuntime()) {
        const { checkForInstallableAppUpdate } = await import("../appUpdater");
        const update = await checkForInstallableAppUpdate();
        await replaceInstallable(update);
        nextResult = update
          ? { status: "available", latestVersion: update.version }
          : { status: "current", latestVersion: CURRENT_APP_VERSION };
      } else {
        await replaceInstallable(null);
        const checked = await checkForProductUpdate();
        nextResult = {
          status: checked.status,
          latestVersion: checked.latestVersion,
        };
      }
      const checkedAt = Date.now();
      const skipped = readString(UPDATE_SKIPPED_VERSION_STORAGE_KEY);
      const visibleVersion =
        nextResult.status === "available"
        && nextResult.latestVersion !== skipped
          ? nextResult.latestVersion
          : null;
      setResult(nextResult);
      setAvailableVersion(visibleVersion);
      setLastCheckedAt(checkedAt);
      setLastCheckFailed(false);
      writeString(UPDATE_CHECKED_AT_STORAGE_KEY, String(checkedAt));
      saveAvailableUpdateVersion(visibleVersion);
    } catch {
      const checkedAt = Date.now();
      setResult("error");
      setLastCheckedAt(checkedAt);
      setLastCheckFailed(true);
      writeString(UPDATE_CHECKED_AT_STORAGE_KEY, String(checkedAt));
    } finally {
      setChecking(false);
    }
  }, [action, checking, replaceInstallable]);

  useEffect(() => {
    const due =
      !lastCheckedAt || Date.now() - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS;
    const timer = due
      ? window.setTimeout(() => void check(false), 5_000)
      : null;
    const retryWhenOnline = () => {
      if (lastCheckFailed) void check(false);
    };
    window.addEventListener("online", retryWhenOnline);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("online", retryWhenOnline);
    };
  }, [check, lastCheckFailed, lastCheckedAt]);

  useEffect(() => () => {
    void currentUpdateRef.current?.close().catch(() => undefined);
  }, []);

  const install = useCallback(async () => {
    if (!installableUpdate || action === "installing" || action === "restarting") {
      return;
    }
    setAction("installing");
    setProgress({
      phase: "downloading",
      downloadedBytes: 0,
      contentLength: null,
      percent: null,
    });
    operationIdRef.current =
      onOperationStart?.(installableUpdate.version) ?? null;
    try {
      await installableUpdate.install(setProgress);
      setAction("ready");
      if (operationIdRef.current) {
        onOperationComplete?.(operationIdRef.current, "succeeded");
        operationIdRef.current = null;
      }
    } catch {
      setAction("installError");
      if (operationIdRef.current) {
        onOperationComplete?.(operationIdRef.current, "failed");
        operationIdRef.current = null;
      }
    }
  }, [
    action,
    installableUpdate,
    onOperationComplete,
    onOperationStart,
  ]);

  const restart = useCallback(async () => {
    if (action !== "ready" && action !== "restartError") return;
    setAction("restarting");
    try {
      const { restartAfterAppUpdate } = await import("../appUpdater");
      await restartAfterAppUpdate();
    } catch {
      setAction("restartError");
    }
  }, [action]);

  const skipAvailableVersion = useCallback(() => {
    if (!availableVersion) return;
    writeString(UPDATE_SKIPPED_VERSION_STORAGE_KEY, availableVersion);
    saveAvailableUpdateVersion(null);
    setAvailableVersion(null);
  }, [availableVersion]);

  const dismissUpdatedReceipt = useCallback(() => {
    setUpdatedFromVersion(null);
  }, []);

  return {
    checking,
    result,
    installableUpdate,
    progress,
    action,
    availableVersion,
    lastCheckedAt,
    lastCheckFailed,
    updatedFromVersion,
    check,
    install,
    restart,
    skipAvailableVersion,
    dismissUpdatedReceipt,
  };
}

function detectUpdatedFromVersion(): string | null {
  const previous = readString(UPDATE_INSTALLED_VERSION_STORAGE_KEY);
  writeString(UPDATE_INSTALLED_VERSION_STORAGE_KEY, CURRENT_APP_VERSION);
  return previous && previous !== CURRENT_APP_VERSION ? previous : null;
}

function readTimestamp(key: string): number | null {
  const value = Number(readString(key) ?? 0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readString(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeString(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The current session still owns the update task state.
  }
}
