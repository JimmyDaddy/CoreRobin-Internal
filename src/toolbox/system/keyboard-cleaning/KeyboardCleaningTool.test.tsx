/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import i18n from "../../../i18n";
import { openSystemSettings } from "../../../api";
import { KEYBOARD_CLEANING_PROTOCOL_VERSION, KEYBOARD_CLEANING_RESTRICTED_HELPER_REASON, type KeyboardCleaningCapability, type KeyboardCleaningSignal } from "./keyboardCleaning";
import { KeyboardCleaningTool, type KeyboardCleaningBridge } from "./KeyboardCleaningTool";

vi.mock("../../../api", () => ({
  isDesktopRuntime: () => false,
  openSystemSettings: vi.fn().mockResolvedValue(undefined),
  startKeyboardCleaning: vi.fn(),
  heartbeatKeyboardCleaning: vi.fn(),
  stopKeyboardCleaning: vi.fn(),
  subscribeKeyboardCleaning: vi.fn(),
}));

afterEach(cleanup);

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("zh-CN");
});

const available: KeyboardCleaningCapability = { state: "available", platform: "macos", reason: null };

function testBridge() {
  let listener: ((signal: KeyboardCleaningSignal) => void) | undefined;
  const send = vi.fn<KeyboardCleaningBridge["send"]>().mockResolvedValue(undefined);
  const unlisten = vi.fn();
  const bridge: KeyboardCleaningBridge = { send, subscribe: vi.fn((callback) => { listener = callback; return unlisten; }) };
  return { bridge, send, unlisten, emit: (signal: KeyboardCleaningSignal) => act(() => listener?.(signal)) };
}

async function startButton() {
  const button = screen.getByRole("button", { name: "开始清洁" }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

it("waits for the native listener before enabling Start", async () => {
  let ready!: (unlisten: () => void) => void;
  const pending = new Promise<() => void>((resolve) => { ready = resolve; });
  const { bridge } = testBridge();
  bridge.subscribe = () => pending;
  const { unmount } = render(<KeyboardCleaningTool capability={available} bridge={bridge} />);
  expect((screen.getByRole("button", { name: "开始清洁" }) as HTMLButtonElement).disabled).toBe(true);
  const unlisten = vi.fn();
  await act(async () => { ready(unlisten); });
  await startButton();
  unmount();
  expect(unlisten).toHaveBeenCalledOnce();
});

it("keeps Start disabled when the signal subscription fails", async () => {
  const { bridge } = testBridge();
  bridge.subscribe = async () => { throw new Error("Signal connection failed"); };
  render(<KeyboardCleaningTool capability={available} bridge={bridge} />);
  expect((await screen.findByRole("alert")).textContent).toContain("Signal connection failed");
  expect((screen.getByRole("button", { name: "开始清洁" }) as HTMLButtonElement).disabled).toBe(true);
});

it("recovers from permission denial and allows retry after opening Accessibility settings", async () => {
  const { bridge, send } = testBridge();
  send.mockRejectedValueOnce({ code: "keyboard_cleaning_permission_required", message: "Permission required" });
  render(<KeyboardCleaningTool capability={available} bridge={bridge} />);
  fireEvent.click(await startButton());
  expect((await screen.findByRole("alert")).textContent).toContain("辅助功能");
  expect(document.querySelector(".keyboard-cleaning-mask")).toBeNull();
  expect(send.mock.calls.map(([effect]) => effect.type)).toEqual(["start_helper"]);
  fireEvent.click(screen.getByRole("button", { name: "打开辅助功能设置" }));
  expect(openSystemSettings).toHaveBeenCalledWith("accessibility");
  fireEvent.click(await startButton());
  expect(send.mock.calls.filter(([effect]) => effect.type === "start_helper")).toHaveLength(2);
});

it("keeps a session across equivalent capability snapshots and confirms release before retry", async () => {
  const { bridge, send, emit } = testBridge();
  const { rerender } = render(<KeyboardCleaningTool capability={{ ...available }} bridge={bridge} />);
  fireEvent.click(await startButton());
  const start = send.mock.calls[0][0];
  if (start.type !== "start_helper") throw new Error("expected Start");
  const { requestId } = start.command.payload;
  expect(send.mock.calls.map(([effect]) => effect.type)).toEqual(["start_helper"]);
  emit({ type: "ready", payload: { protocolVersion: KEYBOARD_CLEANING_PROTOCOL_VERSION, requestId, capability: "available", effectiveness: "confirmed" } });
  await waitFor(() => expect(send.mock.calls.some(([effect]) => effect.type === "heartbeat_helper")).toBe(true));
  rerender(<KeyboardCleaningTool capability={{ ...available }} bridge={bridge} />);
  expect(document.querySelector(".keyboard-cleaning-mask")).not.toBeNull();
  expect(send.mock.calls.some(([effect]) => effect.type === "stop_helper")).toBe(false);
  fireEvent.click(screen.getAllByRole("button", { name: "停止" })[0]);
  expect(send.mock.calls.some(([effect]) => effect.type === "stop_helper")).toBe(true);
  expect((screen.getByRole("button", { name: "开始清洁" }) as HTMLButtonElement).disabled).toBe(true);
  emit({ type: "released", payload: { protocolVersion: KEYBOARD_CLEANING_PROTOCOL_VERSION, requestId, confirmed: true } });
  await startButton();
  expect(document.querySelector(".keyboard-cleaning-mask")).toBeNull();
});

it("localizes the native helper capability reason in the detail view", () => {
  render(<KeyboardCleaningTool capability={{ state: "unavailable", platform: "unknown", reason: KEYBOARD_CLEANING_RESTRICTED_HELPER_REASON }} />);

  expect(screen.getByRole("heading", { name: "键盘清洁" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("当前平台未提供受限原生 helper，部分系统工具暂不可用。");
  expect(screen.getByRole("status").textContent).not.toContain("This tool requires");
  expect((screen.getByRole("button", { name: "开始清洁" }) as HTMLButtonElement).disabled).toBe(true);
});
