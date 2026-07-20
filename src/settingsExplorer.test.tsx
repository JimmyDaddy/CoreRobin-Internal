/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "./i18n";
import { getMockSnapshot } from "./mockData";
import { defaultAppSettings } from "./settings";
import { SettingsExplorer } from "./components/SettingsExplorer";

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => cleanup());

describe("SettingsExplorer", () => {
  it("keeps desktop setting rows explicitly balanced", () => {
    renderSettings();

    expect(screen.getByRole("heading", { name: "界面语言" }).closest("section")?.classList)
      .toContain("settings-card--language");
    expect(screen.getByRole("heading", { name: "历史记录" }).closest("section")?.classList)
      .toContain("settings-card--half");
    expect(screen.getByRole("heading", { name: "桌面提醒" }).closest("section")?.classList)
      .toContain("settings-card--half");
  });

  it("builds an application reminder with the styled condition controls", () => {
    const onChange = vi.fn();
    renderSettings(onChange);

    fireEvent.change(screen.getByPlaceholderText("选择或输入应用名称"), {
      target: { value: "Safari" },
    });
    fireEvent.click(screen.getByRole("button", { name: "内存" }));
    expect((screen.getByRole("spinbutton", { name: "阈值" }) as HTMLInputElement).value)
      .toBe("1024");
    fireEvent.click(screen.getByRole("button", { name: "60 秒" }));
    fireEvent.click(screen.getByRole("button", { name: "添加规则" }));

    expect(onChange).toHaveBeenLastCalledWith({
      applicationWatchRules: [expect.objectContaining({
        applicationName: "Safari",
        metric: "memory",
        threshold: 1_024,
        durationSeconds: 60,
        enabled: true,
      })],
    });
  });
});

function renderSettings(onChange = vi.fn()) {
  return render(
    <SettingsExplorer
      settings={defaultAppSettings("zh-CN")}
      notificationStatus="disabled"
      snapshot={getMockSnapshot()}
      onChange={onChange}
      onOpenOnboarding={() => undefined}
      onClearAllData={() => undefined}
    />,
  );
}
