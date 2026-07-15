/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  openDailyFromCompanion,
  OrbitCompanionWindow,
} from "./components/OrbitCompanionWindow";
import i18n from "./i18nAuxiliary";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(async () => { await i18n.changeLanguage("zh-CN"); });

describe("Orbit companion interactions", () => {
  it("opens the main window without hiding the companion", async () => {
    const calls: string[] = [];

    await openDailyFromCompanion(
      "attention",
      async () => { calls.push("collapse"); },
      {
        showMainWindow: async () => { calls.push("show-main"); },
        openDaily: async (target) => { calls.push(`open-daily:${target}`); },
      },
    );

    expect(calls).toEqual(["collapse", "show-main", "open-daily:overview"]);
  });

  it("opens the status bubble on hover without showing a close button", () => {
    render(<OrbitCompanionWindow />);
    const mascot = screen.getByRole("button", { name: /拖动 Orbit 移动/ });
    const shell = mascot.parentElement;
    expect(shell).not.toBeNull();
    expect(mascot.getAttribute("title")).toBeNull();

    fireEvent.mouseEnter(shell!);

    expect(mascot.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Orbit 小伙伴")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
  });

  it("carries the stable incident identity into the main window", async () => {
    const opened: Array<[string, string | null | undefined]> = [];

    await openDailyFromCompanion(
      "attention",
      async () => undefined,
      {
        showMainWindow: async () => undefined,
        openDaily: async (target, occurrenceId) => {
          opened.push([target, occurrenceId]);
        },
      },
      "diagnosis:sustained_cpu:100",
    );

    expect(opened).toEqual([
      ["overview", "diagnosis:sustained_cpu:100"],
    ]);
  });

  it("offers hiding through the right-click menu", () => {
    render(<OrbitCompanionWindow />);
    const mascot = screen.getByRole("button", { name: /拖动 Orbit 移动/ });
    const shell = mascot.parentElement;
    expect(shell).not.toBeNull();

    fireEvent.contextMenu(shell!);
    expect(screen.getByRole("menu", { name: "Orbit 小伙伴菜单" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "隐藏小伙伴" }));

    expect(mascot.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu", { name: "Orbit 小伙伴菜单" })).toBeNull();
  });

  it("ignores a transient mouse leave while the native window is expanding", () => {
    vi.useFakeTimers();
    render(<OrbitCompanionWindow />);
    const mascot = screen.getByRole("button", { name: /拖动 Orbit 移动/ });
    const shell = mascot.parentElement;
    expect(shell).not.toBeNull();

    fireEvent.mouseEnter(shell!);
    fireEvent.mouseLeave(shell!);
    fireEvent.mouseEnter(shell!);
    act(() => vi.advanceTimersByTime(300));

    expect(mascot.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Orbit 小伙伴")).toBeTruthy();
  });
});
