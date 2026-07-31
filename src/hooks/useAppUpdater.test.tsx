/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UPDATE_REMIND_LATER_MS,
  useAppUpdater,
} from "./useAppUpdater";

const mocks = vi.hoisted(() => ({
  checkForInstallableAppUpdate: vi.fn(),
  getAppUpdateTask: vi.fn(),
}));

vi.mock("../api", () => ({
  isDesktopRuntime: () => true,
}));

vi.mock("../appUpdater", () => ({
  checkForInstallableAppUpdate: mocks.checkForInstallableAppUpdate,
  getAppUpdateTask: mocks.getAppUpdateTask,
  progressFromSnapshot: (task: {
    phase: "downloading" | "installing" | "ready";
    downloadedBytes: number;
    contentLength: number | null;
  }) => ({
    phase: task.phase === "downloading" ? "downloading" : "installing",
    downloadedBytes: task.downloadedBytes,
    contentLength: task.contentLength,
    percent: task.contentLength
      ? Math.round((task.downloadedBytes / task.contentLength) * 100)
      : null,
  }),
  restartAfterAppUpdate: vi.fn(),
}));

describe("useAppUpdater background prompt", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00Z"));
    mocks.checkForInstallableAppUpdate.mockReset();
    mocks.checkForInstallableAppUpdate.mockResolvedValue(update("9.0.0"));
    mocks.getAppUpdateTask.mockReset();
    mocks.getAppUpdateTask.mockResolvedValue(nativeTask("idle"));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("reminds after 24 hours and skips only the selected version", async () => {
    const { result } = renderHook(() => useAppUpdater());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(result.current.promptVisible).toBe(true);
    expect(result.current.availableVersion).toBe("9.0.0");

    act(() => result.current.remindLater());
    expect(result.current.promptVisible).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_REMIND_LATER_MS);
    });
    expect(result.current.promptVisible).toBe(true);

    act(() => result.current.skipAvailableVersion());
    expect(result.current.availableVersion).toBeNull();
    expect(result.current.promptVisible).toBe(false);

    mocks.checkForInstallableAppUpdate.mockResolvedValue(update("9.0.1"));
    await act(async () => {
      await result.current.check(false);
    });
    expect(result.current.availableVersion).toBe("9.0.1");
    expect(result.current.promptVisible).toBe(true);
  });

  it("reattaches to a native update task after the window returns", async () => {
    mocks.getAppUpdateTask.mockResolvedValueOnce(
      nativeTask("downloading", 250, 1_000),
    );
    const { result } = renderHook(() => useAppUpdater());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.action).toBe("installing");
    expect(result.current.progress?.percent).toBe(25);

    mocks.getAppUpdateTask.mockResolvedValue(
      nativeTask("ready", 1_000, 1_000),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(result.current.action).toBe("ready");
    expect(result.current.progress?.percent).toBe(100);
  });
});

function update(version: string) {
  return {
    version,
    notes: null,
    install: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function nativeTask(
  phase: "idle" | "downloading" | "installing" | "ready" | "failed",
  downloadedBytes = 0,
  contentLength: number | null = null,
) {
  return {
    version: phase === "idle" ? null : "9.0.0",
    phase,
    downloadedBytes,
    contentLength,
    updatedAtMs: Date.now(),
  };
}
