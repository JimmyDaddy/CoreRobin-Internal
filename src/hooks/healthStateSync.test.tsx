/** @vitest-environment jsdom */

import { StrictMode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getHealthState, publishHealthState } from "../api";
import type {
  HealthStateSnapshot,
  HealthStateUpdate,
} from "../healthState";
import {
  HEALTH_STATE_RECONNECT_DELAY_MS,
  useSharedHealthState,
} from "./useSharedHealthState";
import { usePublishHealthState } from "./usePublishHealthState";
import { listen } from "@tauri-apps/api/event";

vi.mock("../api", () => ({
  getHealthState: vi.fn(),
  isDesktopRuntime: () => true,
  publishHealthState: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(getHealthState).mockReset();
  vi.mocked(publishHealthState).mockReset();
  vi.mocked(listen).mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("health state synchronization", () => {
  it("publishes the first sample that arrives after a StrictMode remount", async () => {
    vi.mocked(publishHealthState).mockImplementation(async (update) =>
      snapshotAt(update.sampledAtMs),
    );
    const { rerender } = renderHook(
      ({ update }) => usePublishHealthState(update),
      {
        initialProps: { update: null as HealthStateUpdate | null },
        wrapper: StrictMode,
      },
    );

    expect(publishHealthState).not.toHaveBeenCalled();
    const update = updateAt(100);
    rerender({ update });

    await waitFor(() => expect(publishHealthState).toHaveBeenCalledWith(update));
  });

  it("subscribes before reading the retained snapshot", async () => {
    const order: string[] = [];
    const unlisten = vi.fn();
    vi.mocked(listen).mockImplementation(async () => {
      order.push("listen");
      return unlisten;
    });
    vi.mocked(getHealthState).mockImplementation(async () => {
      order.push("read");
      return snapshotAt(100);
    });

    const { result, unmount } = renderHook(() => useSharedHealthState());

    await waitFor(() => expect(result.current?.sampledAtMs).toBe(100));
    expect(order).toEqual(["listen", "read"]);
    unmount();
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("recovers when the first retained-state read fails", async () => {
    vi.useFakeTimers();
    vi.mocked(listen).mockResolvedValue(vi.fn());
    vi.mocked(getHealthState)
      .mockRejectedValueOnce(new Error("IPC unavailable"))
      .mockResolvedValue(snapshotAt(200));

    const { result } = renderHook(() => useSharedHealthState());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTH_STATE_RECONNECT_DELAY_MS);
    });

    expect(getHealthState).toHaveBeenCalledTimes(2);
    expect(result.current?.sampledAtMs).toBe(200);
  });

  it("shows retained data while retrying a failed event subscription", async () => {
    vi.useFakeTimers();
    const unlisten = vi.fn();
    vi.mocked(listen)
      .mockRejectedValueOnce(new Error("event bridge unavailable"))
      .mockResolvedValue(unlisten);
    vi.mocked(getHealthState).mockResolvedValue(snapshotAt(300));

    const { result, unmount } = renderHook(() => useSharedHealthState());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current?.sampledAtMs).toBe(300);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HEALTH_STATE_RECONNECT_DELAY_MS);
    });

    expect(listen).toHaveBeenCalledTimes(2);
    unmount();
    expect(unlisten).toHaveBeenCalledOnce();
  });
});

function updateAt(sampledAtMs: number): HealthStateUpdate {
  return {
    schemaVersion: 3,
    sampledAtMs,
    dataMode: "foreground",
    dataStatus: "fresh",
    paused: false,
    health: "normal",
    reason: "none",
    activeCount: 0,
    pendingCount: 0,
    recoveringCount: 0,
    primaryIncident: null,
    cpuPercent: 10,
    memoryPercent: 20,
    storageUsedPercent: 30,
    storageAvailableBytes: 40,
    temperatureCelsius: 50,
    batteryPercent: 60,
    batteryHealthPercent: 94,
    batteryCycleCount: 173,
    batteryState: "discharging",
  };
}

function snapshotAt(sampledAtMs: number): HealthStateSnapshot {
  return { ...updateAt(sampledAtMs), revision: sampledAtMs };
}
