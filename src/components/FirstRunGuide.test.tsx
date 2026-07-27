/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../i18n";
import { defaultAppSettings } from "../settings";
import { FirstRunGuide } from "./FirstRunGuide";

beforeEach(async () => { await i18n.changeLanguage("zh-CN"); });
afterEach(() => cleanup());

describe("FirstRunGuide", () => {
  const renderGuide = (onComplete = vi.fn(), onChange = vi.fn()) => render(
    <FirstRunGuide
      settings={defaultAppSettings("zh-CN")}
      notificationStatus="disabled"
      onChange={onChange}
      onOpenNotificationSettings={vi.fn()}
      onComplete={onComplete}
    />,
  );

  it("walks through all three steps without requesting a permission", () => {
    const onComplete = vi.fn();
    renderGuide(onComplete);

    expect(screen.getByText("先选择适合你的查看方式")).toBeTruthy();
    expect(screen.getByRole("radio", { name: /专业模式/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("关闭窗口后仍会安静守候")).toBeTruthy();
    expect(screen.getByRole("switch", { name: "在 Dock 中显示" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("权限按需要使用，由你决定")).toBeTruthy();
    expect(screen.getByText(/不授权仍可扫描/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始使用" }));

    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("supports Escape and restores the previous focus when dismissed", () => {
    const previous = document.createElement("button");
    document.body.append(previous);
    previous.focus();
    const onComplete = vi.fn();
    const view = renderGuide(onComplete);

    expect(document.activeElement).toBe(screen.getByRole("heading"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onComplete).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(previous);
    previous.remove();
  });

  it("can be skipped directly", () => {
    const onComplete = vi.fn();
    renderGuide(onComplete);
    fireEvent.click(screen.getAllByRole("button", { name: "暂时跳过" })[0]!);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("applies the selected experience and background preferences", () => {
    const onChange = vi.fn();
    renderGuide(vi.fn(), onChange);
    fireEvent.click(screen.getByRole("radio", { name: /专业模式/ }));
    expect(onChange).toHaveBeenCalledWith({ experienceMode: "professional" });
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByRole("switch", { name: "登录时启动" }));
    expect(onChange).toHaveBeenCalledWith({ launchAtLogin: true });
  });
});
