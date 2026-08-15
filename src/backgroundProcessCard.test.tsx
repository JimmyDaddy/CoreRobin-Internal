/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackgroundProcessCard } from "./components/BackgroundProcessCard";
import i18n from "./i18n";
import type { ProcessRow } from "./types";

function processFixture(
  pid: number,
  backgroundState: ProcessRow["backgroundState"],
): ProcessRow {
  return {
    pid,
    birthToken: `token-${pid}`,
    parentPid: 1,
    startTime: 1_750_000_000,
    runTimeSeconds: 90,
    name: `worker-${pid}`,
    user: "test",
    status: "Run",
    cpuPercent: 0.4,
    memoryBytes: pid * 1_000_000,
    diskReadBytesPerSecond: 0,
    diskWriteBytesPerSecond: 0,
    protected: backgroundState === "managed" || backgroundState === "zombie",
    backgroundState,
    backgroundObservedSeconds: backgroundState === "likely_leftover" ? 42 : null,
    backgroundPreviousParentPid: backgroundState === "likely_leftover" ? 88 : null,
  };
}

afterEach(() => cleanup());
beforeEach(async () => {
  window.localStorage.clear();
  await i18n.changeLanguage("zh-CN");
});

describe("BackgroundProcessCard", () => {
  it("hides managed, unconfirmed, and zombie processes", () => {
    const { container } = render(
      <BackgroundProcessCard
        processes={[
          processFixture(1, "managed"),
          processFixture(2, "unconfirmed"),
          processFixture(3, "zombie"),
        ]}
        onInspect={vi.fn()}
      />,
    );
    expect(container.querySelector(".background-process-card")).toBeNull();
  });

  it("only lists continuously observed residual candidates", () => {
    render(
      <BackgroundProcessCard
        processes={[
          processFixture(4, "likely_leftover"),
          processFixture(5, "managed"),
        ]}
        onInspect={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 个进程在原应用退出后仍持续运行/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    expect(screen.getByText("worker-4")).toBeTruthy();
    expect(screen.queryByText("worker-5")).toBeNull();
    expect(screen.queryByRole("button", { name: /一键|强制|结束/ })).toBeNull();
  });

  it("routes handling through the existing process inspector", () => {
    const candidate = processFixture(6, "likely_leftover");
    const onInspect = vi.fn();
    render(
      <BackgroundProcessCard processes={[candidate]} onInspect={onInspect} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    fireEvent.click(screen.getByRole("button", { name: "检查并处理" }));
    expect(onInspect).toHaveBeenCalledWith(candidate);
  });
});
