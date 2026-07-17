import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkForInstallableAppUpdate,
  restartAfterAppUpdate,
  type AppUpdateProgress,
} from "./appUpdater";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: mocks.relaunch }));

beforeEach(() => {
  mocks.check.mockReset();
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
    const downloadAndInstall = vi.fn(async (onProgress) => {
      onProgress({ event: "Started", data: { contentLength: 1_000 } });
      onProgress({ event: "Progress", data: { chunkLength: 250 } });
      onProgress({ event: "Progress", data: { chunkLength: 750 } });
      onProgress({ event: "Finished" });
    });
    mocks.check.mockResolvedValue({
      version: "0.2.0",
      body: "  Safer updates.  ",
      downloadAndInstall,
      close,
    });

    const update = await checkForInstallableAppUpdate();
    const events: AppUpdateProgress[] = [];
    await update?.install((event) => events.push(event));

    expect(update?.version).toBe("0.2.0");
    expect(update?.notes).toBe("Safer updates.");
    expect(events).toEqual([
      { phase: "downloading", downloadedBytes: 0, contentLength: 1_000, percent: 0 },
      { phase: "downloading", downloadedBytes: 250, contentLength: 1_000, percent: 25 },
      { phase: "downloading", downloadedBytes: 1_000, contentLength: 1_000, percent: 100 },
      { phase: "installing", downloadedBytes: 1_000, contentLength: 1_000, percent: 100 },
    ]);
    await update?.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("restarts through the restricted process plugin", async () => {
    mocks.relaunch.mockResolvedValue(undefined);
    await restartAfterAppUpdate();
    expect(mocks.relaunch).toHaveBeenCalledOnce();
  });
});
