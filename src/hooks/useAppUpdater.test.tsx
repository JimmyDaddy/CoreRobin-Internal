/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  UPDATE_REMIND_LATER_MS,
  useAppUpdater,
} from "./useAppUpdater";

const mocks = vi.hoisted(() => ({
  checkForInstallableAppUpdate: vi.fn(),
}));

vi.mock("../api", () => ({
  isDesktopRuntime: () => true,
}));

vi.mock("../appUpdater", () => ({
  checkForInstallableAppUpdate: mocks.checkForInstallableAppUpdate,
  restartAfterAppUpdate: vi.fn(),
}));

describe("useAppUpdater background prompt", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:00Z"));
    mocks.checkForInstallableAppUpdate.mockReset();
    mocks.checkForInstallableAppUpdate.mockResolvedValue(update("9.0.0"));
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
});

function update(version: string) {
  return {
    version,
    notes: null,
    install: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}
