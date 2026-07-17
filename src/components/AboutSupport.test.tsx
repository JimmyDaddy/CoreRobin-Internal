/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../i18n";
import { getMockSnapshot } from "../mockData";
import { defaultAppSettings } from "../settings";
import { AboutSupport } from "./AboutSupport";

const mocks = vi.hoisted(() => ({
  checkForProductUpdate: vi.fn(),
  openProductPage: vi.fn(),
}));

vi.mock("../api", () => ({
  isDesktopRuntime: () => true,
  openProductPage: mocks.openProductPage,
}));

vi.mock("../productSupport", async () => {
  const actual = await vi.importActual<typeof import("../productSupport")>("../productSupport");
  return { ...actual, checkForProductUpdate: mocks.checkForProductUpdate };
});

beforeEach(async () => {
  mocks.checkForProductUpdate.mockReset();
  mocks.openProductPage.mockReset();
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => cleanup());

describe("AboutSupport", () => {
  it("checks updates and opens only allowlisted product pages", async () => {
    mocks.checkForProductUpdate.mockResolvedValue({
      status: "available",
      latestVersion: "9.0.0",
      releaseUrl: "https://github.com/JimmyDaddy/corerobin-monitor/releases/tag/v9.0.0",
    });
    renderSupport();

    fireEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(await screen.findByText("CoreRobin v9.0.0 已发布")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "前往下载" }));
    fireEvent.click(screen.getByRole("button", { name: "用户指南" }));

    await waitFor(() => {
      expect(mocks.openProductPage).toHaveBeenNthCalledWith(1, "releases_zh");
      expect(mocks.openProductPage).toHaveBeenNthCalledWith(2, "guide_zh");
    });
  });

  it("requires a second confirmation before clearing local data", () => {
    const onClearAllData = vi.fn();
    renderSupport({ onClearAllData });

    fireEvent.click(screen.getByRole("button", { name: "清空全部数据" }));
    expect(onClearAllData).not.toHaveBeenCalled();
    expect(screen.getByText(/此操作无法撤销/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "清空并重新启动" }));
    expect(onClearAllData).toHaveBeenCalledOnce();
  });
});

function renderSupport({
  onClearAllData = vi.fn(),
}: {
  onClearAllData?: () => void;
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
