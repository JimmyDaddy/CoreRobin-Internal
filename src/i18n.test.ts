import { afterEach, describe, expect, it } from "vitest";

import i18n, { normalizeLanguage } from "./i18n";

function resourceKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => resourceKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

afterEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("internationalization", () => {
  it("normalizes supported language variants", () => {
    expect(normalizeLanguage("en-US")).toBe("en");
    expect(normalizeLanguage("zh-TW")).toBe("zh-CN");
    expect(normalizeLanguage(null)).toBe("zh-CN");
  });

  it("switches between complete top-level navigation resources", async () => {
    expect(i18n.t("app.overview")).toBe("概览");
    expect(i18n.t("daily.nav.home")).toBe("电脑状态");
    expect(i18n.t("daily.nav.today")).toBe("电脑状态");
    expect(i18n.t("daily.solve.title")).toBe("你遇到了什么情况？");
    expect(i18n.t("daily.intents.slow.title")).toBe("电脑变慢了");
    expect(i18n.t("daily.status.attention.title", { count: 2 })).toBe(
      "有 2 项情况值得留意",
    );
    expect(i18n.t("diagnosis.kicker")).toBe("智能诊断");
    await i18n.changeLanguage("en");
    expect(i18n.t("app.overview")).toBe("Overview");
    expect(i18n.t("daily.nav.home")).toBe("Status");
    expect(i18n.t("daily.nav.today")).toBe("Status");
    expect(i18n.t("daily.solve.title")).toBe("What are you noticing?");
    expect(i18n.t("daily.intents.slow.title")).toBe("My computer feels slow");
    expect(i18n.t("diagnosis.kicker")).toBe("Smart Diagnosis");
    expect(i18n.t("network.connections.title")).toBe("Active connections");
  });

  it("keeps English and Chinese resource keys in sync", () => {
    const chinese = resourceKeys(
      i18n.getResourceBundle("zh-CN", "translation"),
    ).sort();
    const english = resourceKeys(
      i18n.getResourceBundle("en", "translation"),
    ).sort();

    expect(english).toEqual(chinese);
  });
});
