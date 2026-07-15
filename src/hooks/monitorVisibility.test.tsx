/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getNetworkConnections,
  getSystemSnapshot,
  getSystemSummary,
} from "../api";
import { getMockNetworkConnections, getMockSnapshot } from "../mockData";
import type { SystemSummary } from "../types";
import { useNetworkConnections } from "./useNetworkConnections";
import {
  HIDDEN_SYSTEM_SUMMARY_INTERVAL_MS,
  useSystemMonitor,
} from "./useSystemMonitor";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  getNetworkConnections: vi.fn(),
  getSystemSnapshot: vi.fn(),
  getSystemSummary: vi.fn(),
}));

function mockSummary(): SystemSummary {
  const snapshot = getMockSnapshot();
  return {
    sequence: snapshot.sequence,
    sampledAtMs: snapshot.sampledAtMs,
    sampleIntervalMs: snapshot.sampleIntervalMs,
    cpu: snapshot.cpu,
    memory: snapshot.memory,
    disk: snapshot.disk,
    network: snapshot.network,
    sensors: snapshot.sensors,
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(getSystemSnapshot).mockReset().mockImplementation(async () => getMockSnapshot());
  vi.mocked(getSystemSummary).mockReset().mockImplementation(async () => mockSummary());
  vi.mocked(getNetworkConnections)
    .mockReset()
    .mockImplementation(async () => getMockNetworkConnections());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("visibility-aware system monitoring", () => {
  it("uses the foreground interval, degrades while hidden, and refreshes immediately on show", async () => {
    const { result, rerender } = renderHook(
      ({ visible }) => useSystemMonitor(500, visible),
      { initialProps: { visible: true } },
    );
    await flushEffects();
    expect(getSystemSnapshot).toHaveBeenCalledTimes(1);
    expect(getSystemSummary).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect(getSystemSnapshot).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(getSystemSnapshot).toHaveBeenCalledTimes(2);

    const foregroundSnapshot = result.current.snapshot;
    const foregroundHistoryLength = result.current.history.length;
    rerender({ visible: false });
    await flushEffects();
    expect(getSystemSummary).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot).toBe(foregroundSnapshot);
    expect(result.current.healthSnapshot).toBe(result.current.summary);
    expect(result.current.history.length).toBeGreaterThan(foregroundHistoryLength);

    await act(async () =>
      vi.advanceTimersByTimeAsync(HIDDEN_SYSTEM_SUMMARY_INTERVAL_MS - 1),
    );
    expect(getSystemSummary).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(getSystemSummary).toHaveBeenCalledTimes(2);
    expect(result.current.snapshot).toBe(foregroundSnapshot);
    expect(result.current.healthSnapshot).toBe(result.current.summary);
    expect(result.current.history.length).toBeGreaterThan(foregroundHistoryLength + 1);

    rerender({ visible: true });
    await flushEffects();
    expect(getSystemSnapshot).toHaveBeenCalledTimes(3);
  });

  it("gives pause priority over foreground and hidden sampling", async () => {
    const { result, rerender } = renderHook(
      ({ visible }) => useSystemMonitor(500, visible),
      { initialProps: { visible: true } },
    );
    await flushEffects();

    act(() => result.current.setPaused(true));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(getSystemSnapshot).toHaveBeenCalledTimes(1);
    expect(getSystemSummary).not.toHaveBeenCalled();

    rerender({ visible: false });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(getSystemSummary).not.toHaveBeenCalled();

    act(() => result.current.setPaused(false));
    await flushEffects();
    expect(getSystemSummary).toHaveBeenCalledTimes(1);
  });
});

describe("visibility-aware network monitoring", () => {
  it("stops hidden polling and refreshes immediately when shown", async () => {
    const { rerender } = renderHook(
      ({ visible }) => useNetworkConnections(true, false, 500, visible),
      { initialProps: { visible: true } },
    );
    await flushEffects();
    expect(getNetworkConnections).toHaveBeenCalledTimes(1);

    rerender({ visible: false });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(getNetworkConnections).toHaveBeenCalledTimes(1);

    rerender({ visible: true });
    await flushEffects();
    expect(getNetworkConnections).toHaveBeenCalledTimes(2);
  });
});
