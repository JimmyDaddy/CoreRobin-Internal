/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Loading the main map from an auxiliary entry is a regression even if its
// translations still happen to work. Fail the module import itself.
vi.mock("./i18n/catalogs", () => {
  throw new Error("Auxiliary entries must not import the main catalog map");
});

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
});

afterEach(() => {
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
});

describe("auxiliary translation initialization", () => {
  it.each(["tray", "companion", "splash", "robin-chat"])(
    "loads shared format translations without the main map for %s",
    async (surface) => {
      window.history.replaceState({}, "", `/${surface}.html?source=test`);
      const { default: i18n, appT } = await import("./i18n");
      await i18n.changeLanguage("en");
      expect(appT("format:seconds", { count: 2 })).toBe("2 sec");
      expect(i18n.hasResourceBundle("en", "settings")).toBe(false);
      await i18n.changeLanguage("zh-CN");
      expect(appT("format:seconds", { count: 2 })).toBe("2 秒");
    },
  );
});
