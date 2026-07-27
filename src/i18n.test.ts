// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";

import i18n, {
  appT,
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
  SUPPORTED_LOCALES,
} from "./i18n";
import { loadCatalog } from "./i18n/catalogs";
import { TRANSLATION_NAMESPACES } from "./i18n/namespaces";

function resourceKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => resourceKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function interpolationVariables(value: unknown, prefix = ""):
  Record<string, string[]> {
  if (typeof value === "string") {
    return {
      [prefix]: [...value.matchAll(/\{\{(\w+)/g)]
        .map((match) => match[1]!)
        .sort(),
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      Object.entries(
        interpolationVariables(child, prefix ? `${prefix}.${key}` : key),
      ),
    ),
  );
}

function resourceStrings(
  value: unknown,
  prefix = "",
): Record<string, string> {
  if (typeof value === "string") return { [prefix]: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      Object.entries(resourceStrings(child, prefix ? `${prefix}.${key}` : key)),
    ),
  );
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const PROTECTED_TRANSLATION_TOKENS = [
  "CoreRobin.app",
  "CoreRobin",
  "Robin",
  "macOS",
  "Windows",
  "Linux",
  "Finder",
  "WebView",
  "PID",
  "CPU",
  "TCP",
  "UDP",
  "SYN",
  "ACK",
  "FIN",
  "TCB",
  "SIGKILL",
  "SIGTERM",
  "TerminateProcess",
] as const;
const CRITICAL_LOCALIZED_COPY = {
  applications: [
    "uninstall.bundleOnlyBoundary",
    "uninstall.dialogDescription",
    "uninstall.outcomeDeletedPermanently",
    "uninstall.removed.permanentDescription",
    "uninstall.unavailable.generic",
    "uninstall.errors.application_bundle_unavailable",
  ],
  cleanup: [
    "fileInsights.boundary",
    "fileInsights.processing.dialogTitle",
    "fileInsights.processing.dialogDescription",
  ],
  settings: [
    "watchRules.title",
    "watchRules.description",
    "watchRules.notificationHint",
  ],
} as const;

function pluralStem(key: string): string {
  return key.replace(PLURAL_SUFFIX, "");
}

afterEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("internationalization", () => {
  it("normalizes supported language variants", () => {
    expect(SUPPORTED_LANGUAGES).toEqual([
      "zh-CN",
      "en",
      "zh-Hant",
      "ja",
      "de",
      "fr",
      "es",
      "pt-BR",
      "ko",
      "ru",
    ]);
    expect(normalizeLanguage("en-US")).toBe("en");
    expect(normalizeLanguage("EN_us")).toBe("en");
    expect(normalizeLanguage("zh-CN")).toBe("zh-CN");
    expect(normalizeLanguage("zh-SG")).toBe("zh-CN");
    expect(normalizeLanguage("zh-Hans-HK")).toBe("zh-CN");
    expect(normalizeLanguage("zh-TW")).toBe("zh-Hant");
    expect(normalizeLanguage("zh-HK")).toBe("zh-Hant");
    expect(normalizeLanguage("zh-Hant-SG")).toBe("zh-Hant");
    expect(normalizeLanguage("ja-JP")).toBe("ja");
    expect(normalizeLanguage("de-AT")).toBe("de");
    expect(normalizeLanguage("fr-CA")).toBe("fr");
    expect(normalizeLanguage("es-MX")).toBe("es");
    expect(normalizeLanguage("pt-PT")).toBe("pt-BR");
    expect(normalizeLanguage("ko-KR")).toBe("ko");
    expect(normalizeLanguage("ru-RU")).toBe("ru");
    expect(normalizeLanguage("it-IT")).toBe("zh-CN");
    expect(normalizeLanguage(null)).toBe("zh-CN");
  });

  it("switches between complete top-level navigation resources", async () => {
    expect(appT("app:overview")).toBe("概览");
    expect(appT("daily:nav.home")).toBe("电脑状态");
    expect(appT("daily:nav.today")).toBe("电脑状态");
    expect(appT("daily:solve.title")).toBe("你遇到了什么情况？");
    expect(appT("daily:intents.slow.title")).toBe("电脑变慢了");
    expect(appT("daily:status.attention.title", { count: 2 })).toBe(
      "有 2 项情况值得留意",
    );
    expect(appT("diagnosis:kicker")).toBe("智能诊断");
    await i18n.changeLanguage("en");
    expect(appT("app:overview")).toBe("Overview");
    expect(appT("daily:nav.home")).toBe("Status");
    expect(appT("daily:nav.today")).toBe("Status");
    expect(appT("daily:solve.title")).toBe("What are you noticing?");
    expect(appT("daily:intents.slow.title")).toBe("My computer feels slow");
    expect(appT("diagnosis:kicker")).toBe("Smart Diagnosis");
    expect(appT("network:connections.title")).toBe("Active connections");
  });

  it("loads each registered locale without falling back to a key", async () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(Intl.getCanonicalLocales(locale.code)).toContain(locale.code);
      expect(locale.nativeName).not.toBe("");
      await i18n.changeLanguage(locale.code);
      expect(i18n.resolvedLanguage).toBe(locale.code);
      expect(appT("app:overview")).not.toBe("app:overview");
      expect(document.documentElement.lang).toBe(locale.code);
      expect(document.documentElement.dir).toBe(locale.direction);
    }
  });

  it("selects locale-specific Russian plural forms", async () => {
    await i18n.changeLanguage("ru");
    expect(appT("wellbeing:sleep.blockedValue", { count: 1 })).toBe(
      "1 приложение",
    );
    expect(appT("wellbeing:sleep.blockedValue", { count: 2 })).toBe(
      "2 приложения",
    );
    expect(appT("wellbeing:sleep.blockedValue", { count: 5 })).toBe(
      "5 приложений",
    );
  });

  it("keeps every locale namespace and interpolation contract in sync", async () => {
    for (const namespace of TRANSLATION_NAMESPACES) {
      const [primary, ...secondaryCatalogs] = await Promise.all(
        SUPPORTED_LANGUAGES.map((language) => loadCatalog(language, namespace)),
      );
      const primaryKeys = resourceKeys(primary).sort();
      const primaryKeySet = new Set(primaryKeys);
      const primaryVariables = interpolationVariables(primary);
      for (const catalog of secondaryCatalogs) {
        const localeKeys = resourceKeys(catalog).sort();
        const localeKeySet = new Set(localeKeys);
        const localeVariables = interpolationVariables(catalog);

        expect(
          primaryKeys.filter((key) => !localeKeySet.has(key)),
          `${namespace} missing canonical keys`,
        ).toEqual([]);
        expect(
          localeKeys.filter(
            (key) =>
              !primaryKeySet.has(key) &&
              (!PLURAL_SUFFIX.test(key) ||
                !primaryKeys.some(
                  (primaryKey) => pluralStem(primaryKey) === pluralStem(key),
                )),
          ),
          `${namespace} contains unsupported extra keys`,
        ).toEqual([]);

        for (const key of primaryKeys) {
          expect(localeVariables[key], `${namespace}:${key}`).toEqual(
            primaryVariables[key],
          );
        }

        for (const key of localeKeys.filter((key) => !primaryKeySet.has(key))) {
          const allowedVariables = new Set(
            primaryKeys
              .filter(
                (primaryKey) => pluralStem(primaryKey) === pluralStem(key),
              )
              .flatMap((primaryKey) => primaryVariables[primaryKey] ?? []),
          );
          expect(
            (localeVariables[key] ?? []).filter(
              (variable) => !allowedVariables.has(variable),
            ),
            `${namespace}:${key} interpolation contract`,
          ).toEqual([]);
        }
        expect(
          new Set(localeKeys.map(pluralStem)),
          `${namespace} plural stems`,
        ).toEqual(
          new Set(primaryKeys.map(pluralStem)),
        );
      }
    }
  });

  it("preserves product names and operating-system tokens", async () => {
    for (const namespace of TRANSLATION_NAMESPACES) {
      const english = resourceStrings(await loadCatalog("en", namespace));
      for (const language of SUPPORTED_LANGUAGES.filter(
        (candidate) => candidate !== "en" && candidate !== "zh-CN",
      )) {
        const translated = resourceStrings(
          await loadCatalog(language, namespace),
        );
        for (const [key, source] of Object.entries(english)) {
          for (const token of PROTECTED_TRANSLATION_TOKENS) {
            if (source.includes(token)) {
              expect(
                translated[key],
                `${language}:${namespace}:${key} must preserve ${token}`,
              ).toContain(token);
            }
          }
        }
      }
    }
  });

  it("does not fall back to English for destructive or permission-sensitive copy", async () => {
    for (const namespace of Object.keys(
      CRITICAL_LOCALIZED_COPY,
    ) as Array<keyof typeof CRITICAL_LOCALIZED_COPY>) {
      const keys = CRITICAL_LOCALIZED_COPY[namespace];
      const english = resourceStrings(await loadCatalog("en", namespace));
      for (const language of SUPPORTED_LANGUAGES.filter(
        (candidate) => candidate !== "en",
      )) {
        const translated = resourceStrings(
          await loadCatalog(language, namespace),
        );
        for (const key of keys) {
          expect(
            translated[key],
            `${language}:${namespace}:${key} must be localized`,
          ).not.toBe(english[key]);
        }
      }
    }
  });
});
