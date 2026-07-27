/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "./i18n";
import { previewPath, resolveUserPath, revealPath } from "./api";
import { PathActions } from "./components/PathActions";

vi.mock("./api", () => ({
  previewPath: vi.fn(async () => undefined),
  resolveUserPath: vi.fn(async (path: string) =>
    path.startsWith("~/") ? `/Users/example/${path.slice(2)}` : path),
  revealPath: vi.fn(async () => undefined),
}));

afterEach(() => cleanup());
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  vi.clearAllMocks();
});

describe("filesystem path actions", () => {
  it("reveals and previews only the provided path", async () => {
    render(<PathActions path="/Applications/CoreRobin.app" />);

    fireEvent.click(screen.getByRole("button", { name: "在 Finder 中显示" }));
    await waitFor(() => expect(revealPath).toHaveBeenCalledWith("/Applications/CoreRobin.app"));

    fireEvent.click(screen.getByRole("button", { name: "快速预览" }));
    await waitFor(() => expect(previewPath).toHaveBeenCalledWith("/Applications/CoreRobin.app"));
  });

  it("copies a tilde display path as an absolute path without invoking an operating-system action", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<PathActions path="~/Documents/report.txt" />);

    fireEvent.click(screen.getByRole("button", { name: "复制路径" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/Users/example/Documents/report.txt"));
    expect(resolveUserPath).toHaveBeenCalledWith("~/Documents/report.txt");
    expect(screen.getByText("已复制绝对路径")).toBeTruthy();
    expect(revealPath).not.toHaveBeenCalled();
    expect(previewPath).not.toHaveBeenCalled();
  });
});
