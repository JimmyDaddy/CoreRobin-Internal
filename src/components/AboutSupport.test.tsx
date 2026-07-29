/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../i18n";
import { getMockSnapshot } from "../mockData";
import { defaultAppSettings } from "../settings";
import { AboutSupport } from "./AboutSupport";

const mocks = vi.hoisted(() => ({
  desktopRuntime: true,
  checkForInstallableAppUpdate: vi.fn(),
  restartAfterAppUpdate: vi.fn(),
  checkForProductUpdate: vi.fn(),
  openProductPage: vi.fn(),
}));

vi.mock("../api", () => ({
  isDesktopRuntime: () => mocks.desktopRuntime,
  openProductPage: mocks.openProductPage,
}));

vi.mock("../appUpdater", () => ({
  checkForInstallableAppUpdate: mocks.checkForInstallableAppUpdate,
  restartAfterAppUpdate: mocks.restartAfterAppUpdate,
}));

vi.mock("../productSupport", async () => {
  const actual = await vi.importActual<typeof import("../productSupport")>("../productSupport");
  return { ...actual, checkForProductUpdate: mocks.checkForProductUpdate };
});

beforeEach(async () => {
  mocks.desktopRuntime = true;
  mocks.checkForProductUpdate.mockReset();
  mocks.checkForInstallableAppUpdate.mockReset();
  mocks.restartAfterAppUpdate.mockReset();
  mocks.openProductPage.mockReset();
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => cleanup());

describe("AboutSupport", () => {
  it("checks updates and opens only allowlisted product pages", async () => {
    const install = vi.fn().mockResolvedValue(undefined);
    mocks.checkForInstallableAppUpdate.mockResolvedValue({
      version: "9.0.0",
      notes: null,
      install,
      close: vi.fn().mockResolvedValue(undefined),
    });
    renderSupport();

    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("CoreRobin v9.0.0 已发布")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下载并安装" }));
    expect(await screen.findByText("更新已安装并准备就绪。重新启动后将直接使用新版本。")).toBeTruthy();
    expect(install).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "立即重启并完成更新" }));
    const restarting = await screen.findByRole("button", { name: "正在重新启动…" });
    expect((restarting as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "用户指南" }));

    await waitFor(() => {
      expect(mocks.restartAfterAppUpdate).toHaveBeenCalledOnce();
      expect(mocks.openProductPage).toHaveBeenCalledWith("guide", "zh-CN");
    });
  });

  it("keeps the restart action available when automatic relaunch fails", async () => {
    mocks.checkForInstallableAppUpdate.mockResolvedValue({
      version: "9.0.0",
      notes: null,
      install: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    });
    mocks.restartAfterAppUpdate.mockRejectedValue(new Error("restart failed"));
    renderSupport();

    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    fireEvent.click(await screen.findByRole("button", { name: "下载并安装" }));
    fireEvent.click(await screen.findByRole("button", { name: "立即重启并完成更新" }));

    expect(await screen.findByText(
      "更新已经安装，但 CoreRobin 未能自动重新启动。请重试，或手动退出后重新打开。",
    )).toBeTruthy();
    expect(screen.getByRole("button", { name: "立即重启并完成更新" })).toBeTruthy();
  });

  it("requires a second confirmation before clearing local data", () => {
    const onClearAllData = vi.fn(async () => undefined);
    renderSupport({ onClearAllData });

    fireEvent.click(screen.getByRole("button", { name: "清空全部数据" }));
    expect(onClearAllData).not.toHaveBeenCalled();
    expect(screen.getByText(/此操作无法撤销/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "清空并重新启动" }));
    expect(onClearAllData).toHaveBeenCalledOnce();
  });

  it("keeps the clear dialog open and reports a partial native failure", async () => {
    const onClearAllData = vi.fn(async () => {
      throw new Error("product_data_clear_incomplete");
    });
    renderSupport({ onClearAllData });

    fireEvent.click(screen.getByRole("button", { name: "清空全部数据" }));
    fireEvent.click(screen.getByRole("button", { name: "清空并重新启动" }));

    expect(await screen.findByText(/部分本机数据未能清除/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "重试" })).toBeTruthy();
  });

  it("keeps browser demos on the public download path", async () => {
    mocks.desktopRuntime = false;
    mocks.checkForProductUpdate.mockResolvedValue({
      status: "available",
      latestVersion: "9.0.0",
      releaseUrl: "https://github.com/JimmyDaddy/corerobin-monitor/releases/tag/v9.0.0",
    });
    renderSupport();

    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("CoreRobin v9.0.0 已发布")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "前往下载" }));

    expect(mocks.checkForInstallableAppUpdate).not.toHaveBeenCalled();
    expect(mocks.openProductPage).toHaveBeenCalledWith("releases", "zh-CN");
  });
});

function renderSupport({
  onClearAllData = vi.fn(async () => undefined),
}: {
  onClearAllData?: () => Promise<void>;
} = {}) {
  return render(
    <AboutSupport
      settings={defaultAppSettings("zh-CN")}
      snapshot={getMockSnapshot()}
      onOpenOnboarding={() => undefined}
      onClearAllData={onClearAllData}
    />,
  );
}
