/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import i18n from "../../../i18n";
import { KEYBOARD_CLEANING_RESTRICTED_HELPER_REASON } from "./keyboardCleaning";
import { KeyboardCleaningTool } from "./KeyboardCleaningTool";

afterEach(cleanup);

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

it("localizes the native helper capability reason in the detail view", () => {
  render(<KeyboardCleaningTool capability={{ state: "unavailable", platform: "unknown", reason: KEYBOARD_CLEANING_RESTRICTED_HELPER_REASON }} />);

  expect(screen.getByRole("heading", { name: "键盘清洁" })).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("当前平台未提供受限原生 helper，部分系统工具暂不可用。");
  expect(screen.getByRole("status").textContent).not.toContain("This tool requires");
  expect((screen.getByRole("button", { name: "开始清洁" }) as HTMLButtonElement).disabled).toBe(true);
});
