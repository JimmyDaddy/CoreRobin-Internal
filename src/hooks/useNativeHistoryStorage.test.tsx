/** @vitest-environment jsdom */

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useNativeHistoryStorage } from "./useNativeHistoryStorage";
import type { HistorySegmentStorage } from "../api";

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
    mocks.save.mockImplementation(async (_category, _payload, generation) => ({ byteSize: 10, updatedAtMs: 20, generation: generation + 1 }));
    mocks.clear.mockResolvedValue({ payload: null, byteSize: 0, updatedAtMs: null, generation: 2 });
  });

  it("replays producer updates that arrive while native history is loading", async () => {
    let resolveLoad!: (value: {
      payload: string;
      byteSize: number;
      updatedAtMs: number;
      generation: number;
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
      generation: 0,
    }));

    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.value).toEqual([1, 2]);
  });

  it("flushes pending native data when the page is hidden", async () => {
    mocks.load.mockResolvedValue({ payload: "[]", byteSize: 2, updatedAtMs: 10, generation: 0 });
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

    expect(mocks.save).toHaveBeenCalledWith("resource", "[4]", 0);
  });

  function deferredReceipt() {
    let resolve!: (value: HistorySegmentStorage) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<HistorySegmentStorage>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
  }

  function useFixture(initialValue: number[] = []) {
    return useNativeHistoryStorage<number[]>({
      category: "resource", enabled: true,
      initialValue: () => initialValue,
      parse: (payload) => payload ? JSON.parse(payload) as number[] : [],
      serialize: JSON.stringify, flushDelayMs: 60_000,
    });
  }

  it("waits for an old save before clearing and resumes with the clear generation", async () => {
    mocks.load.mockResolvedValue({ payload: "[]", byteSize: 2, updatedAtMs: 10, generation: 0 });
    const oldSave = deferredReceipt();
    mocks.save.mockReturnValueOnce(oldSave.promise);
    const { result } = renderHook(() => useFixture());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    act(() => result.current.setValue([1]));
    let saving!: Promise<void>;
    act(() => { saving = result.current.persistNow(); });
    expect(mocks.save).toHaveBeenCalledWith("resource", "[1]", 0);
    let clearing!: Promise<HistorySegmentStorage>;
    act(() => { clearing = result.current.clear(); });
    act(() => result.current.setValue([9]));
    await act(async () => result.current.persistNow());
    expect(mocks.clear).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    await act(async () => {
      oldSave.resolve({ payload: null, byteSize: 3, updatedAtMs: 20, generation: 1 });
      await saving;
      await clearing;
    });
    expect(result.current.value).toEqual([]);
    act(() => result.current.setValue([2]));
    await act(async () => result.current.persistNow());
    expect(mocks.save).toHaveBeenLastCalledWith("resource", "[2]", 2);
  });

  it("does not restore a delayed hydration or migrate its old data after clear starts", async () => {
    const oldLoad = deferredReceipt();
    mocks.load.mockReturnValue(oldLoad.promise);
    const { result } = renderHook(() => useFixture([7]));
    let clearing!: Promise<HistorySegmentStorage>;
    act(() => { clearing = result.current.clear(); });
    expect(mocks.clear).not.toHaveBeenCalled();
    await act(async () => {
      oldLoad.resolve({ payload: "[1]", byteSize: 3, updatedAtMs: 10, generation: 0 });
      await clearing;
    });
    expect(result.current.hydrated).toBe(true);
    expect(result.current.value).toEqual([]);
    expect(mocks.save).not.toHaveBeenCalled();
    await act(async () => result.current.persistNow());
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("waits for legacy migration to settle before deleting its result", async () => {
    mocks.load.mockResolvedValue({ payload: null, byteSize: 0, updatedAtMs: null, generation: 0 });
    const migration = deferredReceipt();
    mocks.save.mockReturnValueOnce(migration.promise);
    const { result } = renderHook(() => useFixture([7]));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("resource", "[7]", 0));
    let clearing!: Promise<HistorySegmentStorage>;
    act(() => { clearing = result.current.clear(); });
    expect(mocks.clear).not.toHaveBeenCalled();
    await act(async () => {
      migration.resolve({ payload: null, byteSize: 3, updatedAtMs: 10, generation: 1 });
      await clearing;
    });
    expect(result.current.value).toEqual([]);
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    await act(async () => result.current.persistNow());
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("keeps writes blocked after clear fails and lets the user retry", async () => {
    mocks.load.mockResolvedValue({ payload: "[1]", byteSize: 3, updatedAtMs: 10, generation: 0 });
    mocks.clear.mockRejectedValueOnce(new Error("disk failure"));
    const { result } = renderHook(() => useFixture());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    await act(async () => { await expect(result.current.clear()).rejects.toThrow("disk failure"); });
    expect(result.current.storageStatus.state).toBe("failed");
    expect(result.current.value).toEqual([1]);
    act(() => result.current.setValue([9]));
    await act(async () => result.current.persistNow());
    expect(mocks.save).not.toHaveBeenCalled();
    await act(async () => result.current.clear());
    expect(result.current.value).toEqual([]);
    expect(result.current.storageStatus.state).toBe("ready");
    act(() => result.current.setValue([2]));
    await act(async () => result.current.persistNow());
    expect(mocks.save).toHaveBeenLastCalledWith("resource", "[2]", 2);
  });

  it("serializes concurrent flushes without replaying their captured older values", async () => {
    mocks.load.mockResolvedValue({ payload: "[]", byteSize: 2, updatedAtMs: 10, generation: 0 });
    const first = deferredReceipt();
    mocks.save.mockReturnValueOnce(first.promise);
    const { result } = renderHook(() => useFixture());
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    let firstFlush!: Promise<void>, secondFlush!: Promise<void>, thirdFlush!: Promise<void>;
    act(() => result.current.setValue([1]));
    act(() => { firstFlush = result.current.persistNow(); });
    act(() => result.current.setValue([2]));
    act(() => { secondFlush = result.current.persistNow(); });
    act(() => result.current.setValue([3]));
    act(() => { thirdFlush = result.current.persistNow(); });
    await act(async () => {
      first.resolve({ payload: null, byteSize: 3, updatedAtMs: 10, generation: 1 });
      await Promise.all([firstFlush, secondFlush, thirdFlush]);
    });
    expect(mocks.save.mock.calls).toEqual([["resource", "[1]", 0], ["resource", "[3]", 1]]);
  });
});
