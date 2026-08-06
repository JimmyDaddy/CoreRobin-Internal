/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { QuickCleanupCard } from "./components/QuickCleanupCard";
import i18n from "./i18n";
import type {
  QuickCleanCategorySummary,
  QuickCleanResult,
} from "./types";

const quickCleanApi = vi.hoisted(() => ({
  analyzeQuickCleanup: vi.fn(),
  runQuickCleanup: vi.fn(),
  cancelQuickCleanup: vi.fn(),
}));

vi.mock("./api", () => quickCleanApi);

const SUMMARIES: QuickCleanCategorySummary[] = [
  { category: "user_cache", byteSize: 1_240_000_000, itemCount: 4, skippedCount: 0, available: true },
  { category: "logs", byteSize: 96_000_000, itemCount: 2, skippedCount: 0, available: true },
  { category: "temp_files", byteSize: 0, itemCount: 0, skippedCount: 0, available: true },
  { category: "trash", byteSize: 230_000_000, itemCount: 1, skippedCount: 0, available: false },
];

const RESULT: QuickCleanResult = {
  freedBytes: 1_336_000_000,
  freedItems: 6,
  skippedItems: 1,
  results: [
    { category: "user_cache", freedBytes: 1_240_000_000, freedItems: 4, skippedItems: 0 },
    { category: "logs", freedBytes: 96_000_000, freedItems: 2, skippedItems: 1 },
  ],
};

afterEach(() => cleanup());
beforeEach(async () => {
  window.localStorage.clear();
  quickCleanApi.analyzeQuickCleanup.mockReset();
  quickCleanApi.runQuickCleanup.mockReset();
  quickCleanApi.cancelQuickCleanup.mockReset();
  await i18n.changeLanguage("zh-CN");
});

describe("QuickCleanupCard", () => {
  it("starts in the idle state and analyzes on demand", async () => {
    quickCleanApi.analyzeQuickCleanup.mockResolvedValue(SUMMARIES);
    render(<QuickCleanupCard />);

    expect(screen.getByText("快速清理")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "开始分析" }));

    await waitFor(() => {
      expect(screen.getByText("应用缓存")).toBeTruthy();
      expect(screen.getByText("日志文件")).toBeTruthy();
    });
    expect(screen.getByText("废纸篓").closest("button")?.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/共可释放/)).toBeTruthy();
  });

  it("cleans the selected categories and shows the freed summary", async () => {
    quickCleanApi.analyzeQuickCleanup.mockResolvedValue(SUMMARIES);
    quickCleanApi.runQuickCleanup.mockImplementation(
      async (categories, onProgress) => {
        onProgress({
          category: "user_cache",
          processedItemCount: 1,
          totalItemCount: 1,
          freedBytes: 1_240_000_000,
          freedItems: 4,
          skippedItems: 0,
          currentPath: "user_cache",
        });
        return RESULT;
      },
    );
    render(<QuickCleanupCard />);
    fireEvent.click(screen.getByRole("button", { name: "开始分析" }));
    await waitFor(() => expect(screen.getByText("应用缓存")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /清理/ }));
    await waitFor(() => expect(screen.getByText("清理完成")).toBeTruthy());
    await waitFor(() => {
      expect(screen.getAllByText(/1.2 GB/).length).toBeGreaterThan(0);
    });
    expect(quickCleanApi.runQuickCleanup).toHaveBeenCalledWith(
      ["user_cache", "logs", "temp_files"],
      expect.any(Function),
    );
  });

  it("reports analysis failures without leaving the card stuck", async () => {
    quickCleanApi.analyzeQuickCleanup.mockRejectedValue({
      code: "internal",
      message: "analysis exploded",
    });
    render(<QuickCleanupCard />);
    fireEvent.click(screen.getByRole("button", { name: "开始分析" }));

    await waitFor(() => expect(screen.getByText(/analysis exploded/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "开始分析" })).toBeTruthy();
  });
});
