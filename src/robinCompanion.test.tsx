/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  openDailyFromCompanion,
  RobinCompanionWindow,
} from "./components/RobinCompanionWindow";
import i18n from "./i18nAuxiliary";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(async () => { await i18n.changeLanguage("zh-CN"); });

describe("Robin companion interactions", () => {
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
    render(<RobinCompanionWindow />);
    const mascot = screen.getByRole("button", { name: /拖动 Robin 移动/ });
    const shell = mascot.parentElement;
    expect(shell).not.toBeNull();
    expect(mascot.getAttribute("title")).toBeNull();

    fireEvent.mouseEnter(shell!);

    expect(mascot.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Robin")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "关闭" })).toBeNull();
  });

  it("renders a stateful Robin that follows the pointer", () => {
    render(<RobinCompanionWindow />);
    const mascot = screen.getByRole("button", { name: /拖动 Robin 移动/ });
    const robin = mascot.querySelector<HTMLElement>(".animated-robin");
    expect(robin).not.toBeNull();
    expect(robin?.dataset.mood).toBe("loading");
    expect(robin?.dataset.active).toBe("true");

    vi.spyOn(robin!, "getBoundingClientRect").mockReturnValue({
      bottom: 80,
      height: 80,
      left: 0,
      right: 80,
      top: 0,
      width: 80,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerMove(robin!, {
      clientX: 80,
      clientY: 20,
      pointerType: "mouse",
    });

    expect(robin?.style.getPropertyValue("--robin-head-x")).toBe("4.50px");
    expect(robin?.style.getPropertyValue("--robin-head-turn")).toBe("3.40deg");
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
    render(<RobinCompanionWindow />);
    const mascot = screen.getByRole("button", { name: /拖动 Robin 移动/ });
    const shell = mascot.parentElement;
    expect(shell).not.toBeNull();

    fireEvent.contextMenu(shell!);
    expect(screen.getByRole("menu", { name: "Robin 菜单" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "隐藏 Robin" }));

    expect(mascot.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("menu", { name: "Robin 菜单" })).toBeNull();
  });

  it("ignores a transient mouse leave while the native window is expanding", () => {
    vi.useFakeTimers();
    render(<RobinCompanionWindow />);
    const mascot = screen.getByRole("button", { name: /拖动 Robin 移动/ });
    const shell = mascot.parentElement;
    expect(shell).not.toBeNull();

    fireEvent.mouseEnter(shell!);
    fireEvent.mouseLeave(shell!);
    fireEvent.mouseEnter(shell!);
    act(() => vi.advanceTimersByTime(300));

    expect(mascot.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Robin")).toBeTruthy();
  });
});
