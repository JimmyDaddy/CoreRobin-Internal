/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UserActionTimeline } from "./components/UserActionTimeline";
import i18n from "./i18n";
import type { UserActionRecord } from "./userActionHistory";

afterEach(() => cleanup());
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("user action timeline", () => {
  it("shows a verified cleanup result and opens the related surface", () => {
    const onOpenAction = vi.fn();
    render(
      <UserActionTimeline
        records={[record({
          kind: "cleanup_delete",
          status: "succeeded",
          verification: "verified",
          targetCount: 3,
          affectedBytes: 2_048,
          failedCount: 0,
        })]}
        onOpenAction={onOpenAction}
      />,
    );

    expect(screen.getByText("清理文件")).toBeTruthy();
    expect(screen.getByText(/处理 3 项，释放 2 KB/)).toBeTruthy();
    expect(screen.getByText("已重新核对系统状态")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /查看/ }));
    expect(onOpenAction).toHaveBeenCalledWith("cleanup_delete");
  });

  it("does not invent a persisted application name", () => {
    render(
      <UserActionTimeline
        records={[record({
          kind: "process_close",
          targetName: null,
        })]}
      />,
    );

    expect(screen.getByText("应用名称未保存")).toBeTruthy();
  });
});

function record(overrides: Partial<UserActionRecord>): UserActionRecord {
  return {
    id: "action-1",
    kind: "process_close",
    status: "succeeded",
    verification: "verified",
    startedAtMs: 1_000,
    completedAtMs: 2_000,
    targetName: "Example",
    targetCount: 1,
    affectedBytes: null,
    failedCount: null,
    ...overrides,
  };
}
