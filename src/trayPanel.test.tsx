/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TrayPanel } from "./components/TrayPanel";
import i18n from "./i18nAuxiliary";

const { invokeMock, sharedHealthState } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  sharedHealthState: {
    current: {
      schemaVersion: 1,
      revision: 7,
      sampledAtMs: 1_720_000_000_000,
      dataMode: "background",
      paused: false,
      health: "normal",
      reason: "none",
      activeCount: 0,
      pendingCount: 0,
      recoveringCount: 0,
      primaryIncident: null,
      cpuPercent: 18,
      memoryPercent: 61,
      storageUsedPercent: 72,
      storageAvailableBytes: 76 * 1_024 ** 3,
      temperatureCelsius: 47,
      batteryPercent: 78,
      batteryState: "discharging",
    },
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "tray",
    hide: vi.fn(),
    onFocusChanged: vi.fn(),
  }),
}));
vi.mock("./hooks/useSharedHealthState", () => ({
  useSharedHealthState: () => sharedHealthState.current,
}));

afterEach(() => cleanup());

beforeEach(async () => {
  invokeMock.mockReset();
  await i18n.changeLanguage("zh-CN");
});

describe("tray panel", () => {
  it("shows sampling freshness and battery context from the retained health state", () => {
    render(<TrayPanel />);

    const updatedTime = new Date(sharedHealthState.current.sampledAtMs).toLocaleTimeString(
      "zh-CN",
      { hour: "2-digit", minute: "2-digit" },
    );
    expect(screen.getByText(`${updatedTime} 更新`)).toBeTruthy();
    expect(screen.getByText("后台采样")).toBeTruthy();
    expect(screen.getByText("正在使用电池")).toBeTruthy();
  });

  it("exposes a tray-only application quit action", async () => {
    render(<TrayPanel />);

    fireEvent.click(screen.getByRole("button", { name: "退出应用" }));

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("quit_application"));
  });
});
