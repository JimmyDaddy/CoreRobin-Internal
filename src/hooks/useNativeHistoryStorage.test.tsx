/** @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useNativeHistoryStorage } from "./useNativeHistoryStorage";

const mocks = vi.hoisted(() => ({
  clear: vi.fn(),
  load: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../api", () => ({
  isDesktopRuntime: () => true,
  clearHistoryStorage: mocks.clear,
  loadHistoryStorage: mocks.load,
  saveHistoryStorage: mocks.save,
}));

describe("useNativeHistoryStorage", () => {
  beforeEach(() => {
    mocks.clear.mockReset();
    mocks.load.mockReset();
    mocks.save.mockReset();
    mocks.save.mockResolvedValue({ byteSize: 10, updatedAtMs: 20 });
  });

  it("replays producer updates that arrive while native history is loading", async () => {
    let resolveLoad!: (value: {
      payload: string;
      byteSize: number;
      updatedAtMs: number;
    }) => void;
    mocks.load.mockReturnValue(new Promise((resolve) => {
      resolveLoad = resolve;
    }));
    const { result } = renderHook(() => useNativeHistoryStorage<number[]>({
      category: "resource",
      enabled: true,
      initialValue: () => [],
      parse: (payload) => payload ? JSON.parse(payload) as number[] : [],
      serialize: JSON.stringify,
      flushDelayMs: 60_000,
    }));

    act(() => result.current.setValue((current) => [...current, 2]));
    expect(result.current.value).toEqual([2]);
    await act(async () => resolveLoad({
      payload: "[1]",
      byteSize: 3,
      updatedAtMs: 10,
    }));

    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.value).toEqual([1, 2]);
  });

  it("flushes pending native data when the page is hidden", async () => {
    mocks.load.mockResolvedValue({ payload: "[]", byteSize: 2, updatedAtMs: 10 });
    const { result } = renderHook(() => useNativeHistoryStorage<number[]>({
      category: "resource",
      enabled: true,
      initialValue: () => [],
      parse: (payload) => payload ? JSON.parse(payload) as number[] : [],
      serialize: JSON.stringify,
      flushDelayMs: 60_000,
    }));
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    act(() => result.current.setValue([4]));

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    expect(mocks.save).toHaveBeenCalledWith("resource", "[4]");
  });
});
