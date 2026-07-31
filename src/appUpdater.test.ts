import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkForInstallableAppUpdate,
  progressFromSnapshot,
  restartAfterAppUpdate,
  type AppUpdateProgress,
} from "./appUpdater";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  invoke: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

beforeEach(() => {
  mocks.check.mockReset();
  mocks.invoke.mockReset();
  mocks.relaunch.mockReset();
});

describe("app updater", () => {
  it("returns null when the signed updater reports no newer release", async () => {
    mocks.check.mockResolvedValue(null);

    await expect(checkForInstallableAppUpdate()).resolves.toBeNull();
    expect(mocks.check).toHaveBeenCalledWith({ timeout: 15_000 });
  });

  it("maps download progress and installs the verified update", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    mocks.check.mockResolvedValue({
      version: "0.2.0",
      body: "  Safer updates.  ",
      close,
    });
    mocks.invoke.mockResolvedValue({
      version: "0.2.0",
      phase: "ready",
      downloadedBytes: 1_000,
      contentLength: 1_000,
      updatedAtMs: 1,
    });

    const update = await checkForInstallableAppUpdate();
    const events: AppUpdateProgress[] = [];
    await update?.install((event) => events.push(event));

    expect(update?.version).toBe("0.2.0");
    expect(update?.notes).toBe("Safer updates.");
    expect(events).toEqual([
      { phase: "installing", downloadedBytes: 1_000, contentLength: 1_000, percent: 100 },
    ]);
    expect(mocks.invoke).toHaveBeenCalledWith("start_app_update", {
      version: "0.2.0",
    });
    await update?.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("maps native background task progress for the update UI", () => {
    expect(progressFromSnapshot({
      version: "0.2.0",
      phase: "downloading",
      downloadedBytes: 250,
      contentLength: 1_000,
      updatedAtMs: 1,
    })).toEqual({
      phase: "downloading",
      downloadedBytes: 250,
      contentLength: 1_000,
      percent: 25,
    });
  });

  it("restarts through the restricted process plugin", async () => {
    mocks.relaunch.mockResolvedValue(undefined);
    await restartAfterAppUpdate();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
});
