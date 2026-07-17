/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "../i18n";
import { FirstRunGuide } from "./FirstRunGuide";

beforeEach(async () => { await i18n.changeLanguage("zh-CN"); });
afterEach(() => cleanup());

describe("FirstRunGuide", () => {
  it("walks through all three steps without requesting a permission", () => {
    const onComplete = vi.fn();
    render(<FirstRunGuide onComplete={onComplete} />);

    expect(screen.getByText("先选择适合你的查看方式")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText("关闭窗口后仍会安静守候")).toBeTruthy();
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
    const view = render(<FirstRunGuide onComplete={onComplete} />);

    expect(document.activeElement).toBe(screen.getByRole("heading"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onComplete).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(previous);
    previous.remove();
  });

  it("can be skipped directly", () => {
    const onComplete = vi.fn();
    render(<FirstRunGuide onComplete={onComplete} />);
    fireEvent.click(screen.getAllByRole("button", { name: "暂时跳过" })[0]!);
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
