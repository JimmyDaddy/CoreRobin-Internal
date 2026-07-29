/** @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useTrashApplicationWatcher } from "./useTrashApplicationWatcher";

const { getTrashedApplications } = vi.hoisted(() => ({
  getTrashedApplications: vi.fn(),
}));

vi.mock("../api", () => ({ getTrashedApplications }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useTrashApplicationWatcher", () => {
  it("keeps watching outside the applications page and clears when disabled", async () => {
    getTrashedApplications.mockResolvedValue([{
      name: "Example",
      path: "/Users/example/.Trash/Example.app",
      bundleId: "com.example.app",
      modifiedAtMs: 1,
    }]);
    const { result, rerender } = renderHook(
      ({ enabled }) => useTrashApplicationWatcher(enabled, "en"),
      { initialProps: { enabled: true } },
    );

    await waitFor(() => expect(result.current.applications).toHaveLength(1));
    expect(getTrashedApplications).toHaveBeenCalledWith("en");

    rerender({ enabled: false });
    await waitFor(() => expect(result.current.applications).toEqual([]));
  });

  it("refreshes every 30 seconds while enabled", async () => {
    vi.useFakeTimers();
    getTrashedApplications.mockResolvedValue([]);
    renderHook(() => useTrashApplicationWatcher(true, "en"));
    await act(async () => undefined);
    expect(getTrashedApplications).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(getTrashedApplications).toHaveBeenCalledTimes(2);
  });
});
