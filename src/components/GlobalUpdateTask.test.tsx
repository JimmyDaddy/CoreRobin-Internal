/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppUpdaterController } from "../hooks/useAppUpdater";
import i18n from "../i18n";
import { GlobalUpdateTask } from "./GlobalUpdateTask";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("global update prompt", () => {
  it("offers install, tomorrow, and version-scoped skip without blocking the window", () => {
    const install = vi.fn(async () => undefined);
    const remindLater = vi.fn();
    const skipAvailableVersion = vi.fn();
    render(
      <GlobalUpdateTask
        updater={updater({
          install,
          remindLater,
          skipAvailableVersion,
        })}
      />,
    );

    const prompt = screen.getByRole("dialog");
    expect(prompt.getAttribute("aria-modal")).toBe("false");
    expect(screen.getByText("CoreRobin v9.0.0 已发布")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "下载并安装" }));
    fireEvent.click(screen.getByRole("button", { name: "明天提醒我" }));
    fireEvent.click(screen.getByRole("button", { name: "跳过 v9.0.0" }));

    expect(install).toHaveBeenCalledOnce();
    expect(remindLater).toHaveBeenCalledOnce();
    expect(skipAvailableVersion).toHaveBeenCalledOnce();
  });

  it("collapses a successful update receipt after nine seconds", () => {
    vi.useFakeTimers();
    const dismissUpdatedReceipt = vi.fn();
    render(
      <GlobalUpdateTask
        updater={updater({
          promptVisible: false,
          availableVersion: null,
          updatedFromVersion: "1.2.3",
          dismissUpdatedReceipt,
        })}
      />,
    );

    expect(screen.getByText("已从 v1.2.3 成功更新")).toBeTruthy();
    act(() => vi.advanceTimersByTime(9_000));

    const compact = screen.getByRole("button", {
      name: "已从 v1.2.3 成功更新",
    });
    expect(compact).toBeTruthy();
    expect(screen.getByText("已更新")).toBeTruthy();

    fireEvent.click(compact);
    expect(screen.getByText("已从 v1.2.3 成功更新")).toBeTruthy();
    expect(dismissUpdatedReceipt).not.toHaveBeenCalled();
  });
});

function updater(
  overrides: Partial<AppUpdaterController> = {},
): AppUpdaterController {
  return {
    checking: false,
    result: { status: "available", latestVersion: "9.0.0" },
    installableUpdate: {
      version: "9.0.0",
      notes: "今日回顾与 Robin 交互优化",
      install: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    },
    progress: null,
    action: "idle",
    availableVersion: "9.0.0",
    promptVisible: true,
    lastCheckedAt: Date.now(),
    lastCheckFailed: false,
    updatedFromVersion: null,
    check: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
    restart: vi.fn(async () => undefined),
    remindLater: vi.fn(),
    skipAvailableVersion: vi.fn(),
    dismissUpdatedReceipt: vi.fn(),
    ...overrides,
  };
}
