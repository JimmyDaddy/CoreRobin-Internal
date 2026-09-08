/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApplicationCapabilityState } from "../capabilities/api";
import type { NetworkQualityResult } from "../types";
const mocks = vi.hoisted(() => ({ read: vi.fn(), run: vi.fn(), setHistory: vi.fn(), change: null as null | (() => Promise<void>) }));
vi.mock("../api", () => ({ isDesktopRuntime: () => true, runNetworkQualityCheck: mocks.run }));
vi.mock("../capabilities/api", () => ({ readApplicationCapabilities: mocks.read }));
vi.mock("../capabilities/useCapabilityChanges", () => ({ useCapabilityChanges: (_: string, callback: () => Promise<void>) => { mocks.change = callback; } }));
vi.mock("./useNativeHistoryStorage", () => ({ useNativeHistoryStorage: () => ({ value: [], setValue: mocks.setHistory, clear: vi.fn(), storageStatus: { state: "ready" } }) }));
import { useNetworkQualityMonitor } from "./useNetworkQualityMonitor";
const check = (sampledAtMs: number) => ({ sampledAtMs, status: "healthy", diagnostics: [] }) as unknown as NetworkQualityResult;
const shared = (networkRevision: number, network: NetworkQualityResult | null): ApplicationCapabilityState => ({ diskRevision: 0, diskRequiresRescan: false, networkRevision, network });
beforeEach(() => { vi.clearAllMocks(); mocks.read.mockResolvedValue(shared(0, null)); });
afterEach(cleanup);
it("adopts a native AI check in an already mounted page without enabling history or running a duplicate check", async () => {
  const { result } = renderHook(() => useNetworkQualityMonitor({ active: false, historyEnabled: false, historyHours: 24 }));
  await waitFor(() => expect(mocks.read).toHaveBeenCalled());
  mocks.read.mockResolvedValue(shared(1, check(100)));
  await act(async () => { await mocks.change?.(); });
  expect(result.current.result?.sampledAtMs).toBe(100);
  expect(mocks.run).not.toHaveBeenCalled();
  expect(mocks.setHistory).not.toHaveBeenCalled();
});
it("does not resurrect an older response after the shared data was cleared", async () => {
  mocks.read.mockResolvedValue(shared(1, check(100)));
  const { result } = renderHook(() => useNetworkQualityMonitor({ active: false, historyEnabled: false, historyHours: 24 }));
  await waitFor(() => expect(result.current.result?.sampledAtMs).toBe(100));
  let finish!: (value: ApplicationCapabilityState) => void;
  mocks.read.mockImplementationOnce(() => new Promise<ApplicationCapabilityState>((resolve) => { finish = resolve; }));
  const pending = mocks.change!();
  mocks.read.mockResolvedValue(shared(3, null));
  await act(async () => { await mocks.change?.(); });
  await act(async () => { finish(shared(2, check(200))); await pending; });
  expect(result.current.result).toBeNull();
  expect(result.current.sessionSamples).toEqual([]);
});
