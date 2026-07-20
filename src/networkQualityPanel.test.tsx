/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  NETWORK_QUALITY_REFRESH_MS,
  NETWORK_QUALITY_WINDOW_MS,
  NetworkQualityPanel,
  appendNetworkQualitySample,
} from "./components/NetworkExplorer";
import i18n from "./i18n";
import type { NetworkQualityResult } from "./types";

const { runNetworkQualityCheck } = vi.hoisted(() => ({
  runNetworkQualityCheck: vi.fn(),
}));

vi.mock("./api", () => ({ runNetworkQualityCheck }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(async () => {
  vi.clearAllMocks();
  runNetworkQualityCheck.mockImplementation(async () => qualityResult(Date.now()));
  await i18n.changeLanguage("zh-CN");
});

describe("network quality monitoring", () => {
  it("checks automatically, reports probe counts, and keeps a manual recheck", async () => {
    render(<NetworkQualityPanel />);

    expect(await screen.findByText("6/6 次成功")).toBeTruthy();
    expect(runNetworkQualityCheck).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: /共 1 个样本/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "立即复测" }));
    await waitFor(() => expect(runNetworkQualityCheck).toHaveBeenCalledTimes(2));
  });

  it("samples every 30 seconds while mounted and stops after leaving", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-20T15:00:00Z"));
    const view = render(<NetworkQualityPanel />);
    await act(async () => undefined);
    expect(runNetworkQualityCheck).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(NETWORK_QUALITY_REFRESH_MS);
    });
    expect(runNetworkQualityCheck).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("img", { name: /共 2 个样本/ })).toBeTruthy();

    view.unmount();
    await vi.advanceTimersByTimeAsync(NETWORK_QUALITY_REFRESH_MS);
    expect(runNetworkQualityCheck).toHaveBeenCalledTimes(2);
  });

  it("keeps only the latest 15-minute sampling window", () => {
    const latestAt = 10_000_000;
    const tooOld = qualityResult(latestAt - NETWORK_QUALITY_WINDOW_MS - 1);
    const insideWindow = qualityResult(latestAt - NETWORK_QUALITY_WINDOW_MS);
    const latest = qualityResult(latestAt);

    expect(appendNetworkQualitySample([tooOld, insideWindow], latest).map((sample) => sample.sampledAtMs))
      .toEqual([insideWindow.sampledAtMs, latest.sampledAtMs]);
  });
});

function qualityResult(sampledAtMs: number): NetworkQualityResult {
  return {
    sampledAtMs,
    targetHost: "example.com",
    targetPort: 443,
    status: "online",
    dnsAvailable: true,
    dnsLookupMs: 2,
    resolvedAddressCount: 4,
    probeCount: 6,
    successfulProbeCount: 6,
    averageLatencyMs: 24,
    minimumLatencyMs: 20,
    maximumLatencyMs: 31,
    jitterMs: 3,
    packetLossPercent: 0,
  };
}
