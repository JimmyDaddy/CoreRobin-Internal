/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import i18n from "../../i18n";
import { AiErrorNotice } from "./AiErrorNotice";
afterEach(cleanup);
it("reports a local tool input error as a task failure with its code, not a connection configuration failure", async () => {
  await i18n.changeLanguage("zh-CN");
  render(<AiErrorNotice context="tool" error={{ code: "invalid_json", message: "The fixed local utility did not complete." }} />);
  expect(screen.getByText(i18n.t("ai:taskError"))).toBeTruthy();
  expect(screen.queryByText(i18n.t("ai:settingsError"))).toBeNull();
  expect(screen.getByText("invalid_json")).toBeTruthy();
});
