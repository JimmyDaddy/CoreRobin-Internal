/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GpuEnergySnapshot } from "../types";
const api = vi.hoisted(() => ({ getGpuEnergySnapshot: vi.fn() }));
vi.mock("../api", () => api);
import { useGpuEnergyMonitor } from "./useGpuEnergyMonitor";
afterEach(cleanup);
it("deduplicates readers and lets a new request survive completion of a cleared request", async () => {
  let oldDone!: (value: GpuEnergySnapshot) => void;
  let newDone!: (value: GpuEnergySnapshot) => void;
  api.getGpuEnergySnapshot.mockImplementationOnce(() => new Promise((resolve) => { oldDone = resolve; }))
    .mockImplementationOnce(() => new Promise((resolve) => { newDone = resolve; }));
  const { result } = renderHook(useGpuEnergyMonitor);
  let oldWork!: Promise<void>;
  await act(async () => { oldWork = result.current.refresh(); expect(result.current.refresh()).toBe(oldWork); });
  act(() => result.current.clear());
  let newWork!: Promise<void>;
  await act(async () => { newWork = result.current.refresh(); });
  const oldValue = { sampledAtMs: 10 } as GpuEnergySnapshot;
  const newValue = { sampledAtMs: 20 } as GpuEnergySnapshot;
  await act(async () => { oldDone(oldValue); await oldWork; });
  expect(result.current.snapshot).toBeNull();
  expect(result.current.loading).toBe(true);
  expect(result.current.refresh()).toBe(newWork);
  await act(async () => { newDone(newValue); await newWork; });
  expect(result.current.snapshot).toBe(newValue);
  expect(result.current.loading).toBe(false);
  expect(api.getGpuEnergySnapshot).toHaveBeenCalledTimes(2);
});
