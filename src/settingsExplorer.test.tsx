/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "./i18n";
import { getMockSnapshot } from "./mockData";
import type { AppUpdaterController } from "./hooks/useAppUpdater";
import { defaultAppSettings } from "./settings";
import { SettingsExplorer } from "./components/SettingsExplorer";

const updaterStub: AppUpdaterController = {
  checking: false,
  result: null,
  installableUpdate: null,
  progress: null,
  action: "idle",
  availableVersion: null,
  promptVisible: false,
  lastCheckedAt: null,
  lastCheckFailed: false,
  updatedFromVersion: null,
  check: vi.fn(async () => undefined),
  install: vi.fn(async () => undefined),
  restart: vi.fn(async () => undefined),
  remindLater: vi.fn(),
  skipAvailableVersion: vi.fn(),
  dismissUpdatedReceipt: vi.fn(),
};

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => cleanup());

describe("SettingsExplorer", () => {
  it("keeps desktop setting rows explicitly balanced", () => {
    renderSettings();

    const interfaceCard = screen
      .getByRole("heading", { name: "界面与语言" })
      .closest("section");
    expect(interfaceCard?.classList).toContain("settings-card--interface");
    expect(within(interfaceCard!).getByRole("group", { name: "界面模式" })).toBeTruthy();
    expect(within(interfaceCard!).getByRole("combobox", { name: "语言" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "数据与隐私中心" }));
    expect(screen.getByRole("heading", { name: "历史记录" }).closest("section")?.classList)
      .toContain("settings-card--half");
    fireEvent.click(screen.getByRole("button", { name: "桌面提醒" }));
    expect(screen.getByRole("heading", { name: "桌面提醒" }).closest("section")?.classList)
      .toContain("settings-card--half");
  });

  it("builds an application reminder with the styled condition controls", () => {
    const onChange = vi.fn();
    renderSettings(onChange);
    fireEvent.click(screen.getByRole("button", { name: "桌面提醒" }));

    fireEvent.change(screen.getByPlaceholderText("选择或输入应用名称"), {
      target: { value: "Terminal" },
    });
    fireEvent.click(screen.getByRole("button", { name: "内存" }));
    expect((screen.getByRole("spinbutton", { name: "阈值" }) as HTMLInputElement).value)
      .toBe("1024");
    fireEvent.click(screen.getByRole("button", { name: "60 秒" }));
    fireEvent.click(screen.getByRole("button", { name: "添加规则" }));

    expect(onChange).toHaveBeenLastCalledWith({
      applicationWatchRules: [expect.objectContaining({
        applicationName: "Terminal",
        metric: "memory",
        threshold: 1_024,
        durationSeconds: 60,
        enabled: true,
      })],
    });
  });

  it("exposes the toolbox history policy without changing the safe default", () => {
    const onChange = vi.fn();
    renderSettings(onChange);
    fireEvent.click(screen.getByRole("button", { name: "桌面提醒" }));

    const historySwitch = screen.getByRole("switch", {
      name: "保存工具箱任务历史",
    });
    expect((historySwitch as HTMLInputElement).checked).toBe(false);
    fireEvent.click(historySwitch);

    expect(onChange).toHaveBeenLastCalledWith({ toolboxHistoryEnabled: true });
  });

  it("keeps a manually entered application as waiting instead of blocking it", () => {
    const onChange = vi.fn();
    renderSettings(onChange);
    fireEvent.click(screen.getByRole("button", { name: "桌面提醒" }));

    fireEvent.change(screen.getByPlaceholderText("选择或输入应用名称"), {
      target: { value: "Not Running Yet" },
    });
    fireEvent.click(screen.getByRole("button", { name: "添加规则" }));

    expect(onChange).toHaveBeenLastCalledWith({
      applicationWatchRules: [expect.objectContaining({
        applicationName: "Not Running Yet",
        enabled: true,
      })],
    });
  });

  it("uses the same confirmation flow before clearing data from the privacy center", () => {
    const onClearAllData = vi.fn(async () => undefined);
    renderSettings(vi.fn(), onClearAllData);
    fireEvent.click(screen.getByRole("button", { name: "数据与隐私中心" }));

    fireEvent.click(screen.getByRole("button", { name: "清空全部本机数据" }));
    expect(onClearAllData).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "清空并重新启动" }));

    expect(onClearAllData).toHaveBeenCalledOnce();
  });
});

function renderSettings(
  onChange = vi.fn(),
  onClearAllData = vi.fn(async () => undefined),
) {
  return render(
    <SettingsExplorer
      settings={defaultAppSettings("zh-CN")}
      notificationStatus="disabled"
      snapshot={getMockSnapshot()}
      updater={updaterStub}
      onChange={onChange}
      onOpenOnboarding={() => undefined}
      onClearAllData={onClearAllData}
    />,
  );
}
