/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GpuEnergyPanel } from "./components/GpuEnergyPanel";
import i18n from "./i18n";
import type { ProcessRow } from "./types";

const { getGpuEnergySnapshot } = vi.hoisted(() => ({
  getGpuEnergySnapshot: vi.fn(),
}));

vi.mock("./api", () => ({ getGpuEnergySnapshot }));

afterEach(() => cleanup());

beforeEach(async () => {
  vi.clearAllMocks();
  getGpuEnergySnapshot.mockResolvedValue({
    sampledAtMs: Date.now(),
    gpuAvailable: true,
    processEnergyAvailable: true,
    adapters: [{
      name: "Apple GPU",
      utilizationPercent: 18,
      memoryUsedBytes: 1_420_000_000,
      memoryTotalBytes: null,
      coreCount: 14,
    }],
    processEnergy: [
      { pid: 10, impact: 10 },
      { pid: 20, impact: 5 },
      { pid: 30, impact: 0 },
    ],
  });
  await i18n.changeLanguage("zh-CN");
});

describe("GPU energy panel", () => {
  it("samples only after expansion and omits zero-value process rows", async () => {
    render(<GpuEnergyPanel processes={[
      processRow(10, "Video Editor"),
      processRow(20, "Browser"),
      processRow(30, "Idle Service"),
    ]} />);

    expect(getGpuEnergySnapshot).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /GPU 与相对能耗/ }));

    await waitFor(() => expect(getGpuEnergySnapshot).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Video Editor")).toBeTruthy();
    expect(screen.getByText("Browser")).toBeTruthy();
    expect(screen.queryByText("Idle Service")).toBeNull();
    expect(screen.getByText("Video Editor").closest("li")?.querySelector("i")?.style.width).toBe("100%");
    expect(screen.getByText("Browser").closest("li")?.querySelector("i")?.style.width).toBe("50%");
  });

  it("explains an all-zero sample instead of presenting a broken ranking", async () => {
    getGpuEnergySnapshot.mockResolvedValueOnce({
      sampledAtMs: Date.now(),
      gpuAvailable: true,
      processEnergyAvailable: true,
      adapters: [],
      processEnergy: [{ pid: 30, impact: 0 }],
    });
    render(<GpuEnergyPanel processes={[processRow(30, "Idle Service")]} />);

    fireEvent.click(screen.getByRole("button", { name: /GPU 与相对能耗/ }));

    expect(await screen.findByText("本次采样没有检测到可区分的进程能耗活动。")).toBeTruthy();
    expect(screen.queryByText("Idle Service")).toBeNull();
  });
});

function processRow(pid: number, name: string): ProcessRow {
  return {
    pid,
    birthToken: `mock:${pid}`,
    parentPid: 1,
    startTime: 1,
    runTimeSeconds: 60,
    name,
    user: "demo",
    status: "Run",
    cpuPercent: 1,
    memoryBytes: 1_024,
    diskReadBytesPerSecond: 0,
    diskWriteBytesPerSecond: 0,
    protected: false,
  };
}
