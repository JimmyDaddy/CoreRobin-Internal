/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import i18n from "./i18n";
import { previewPath, revealPath } from "./api";
import { PathActions } from "./components/PathActions";

vi.mock("./api", () => ({
  previewPath: vi.fn(async () => undefined),
  revealPath: vi.fn(async () => undefined),
}));

afterEach(() => cleanup());
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  vi.clearAllMocks();
});

describe("filesystem path actions", () => {
  it("reveals and previews only the provided path", async () => {
    render(<PathActions path="/Applications/StatusOrbit.app" />);

    fireEvent.click(screen.getByRole("button", { name: "在 Finder 中显示" }));
    await waitFor(() => expect(revealPath).toHaveBeenCalledWith("/Applications/StatusOrbit.app"));

    fireEvent.click(screen.getByRole("button", { name: "快速预览" }));
    await waitFor(() => expect(previewPath).toHaveBeenCalledWith("/Applications/StatusOrbit.app"));
  });

  it("copies the exact path without invoking an operating-system action", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<PathActions path="/Users/example/Documents/report.txt" />);

    fireEvent.click(screen.getByRole("button", { name: "复制路径" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/Users/example/Documents/report.txt"));
    expect(screen.getByText("路径已复制")).toBeTruthy();
    expect(revealPath).not.toHaveBeenCalled();
    expect(previewPath).not.toHaveBeenCalled();
  });
});
