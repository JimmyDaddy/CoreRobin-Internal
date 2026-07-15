import {
  LEGACY_STORAGE_KEYS,
  readMigratedStorageItem,
} from "./storageMigration";

export const LANGUAGE_STORAGE_KEY = "status-orbit.language.v1";

type LocaleDefinition = {
  code: string;
  nativeName: string;
  compactLabel: string;
  direction: "ltr" | "rtl";
  aliases: readonly string[];
  scripts: readonly string[];
};

export const SUPPORTED_LOCALES = [
  {
    code: "zh-CN",
    nativeName: "简体中文",
    compactLabel: "中文",
    direction: "ltr",
    aliases: ["zh-Hans", "zh-SG"],
    scripts: ["Hans"],
  },
  {
    code: "en",
    nativeName: "English",
    compactLabel: "EN",
    direction: "ltr",
    aliases: [],
    scripts: [],
  },
  {
    code: "zh-Hant",
    nativeName: "繁體中文",
    compactLabel: "繁中",
    direction: "ltr",
    aliases: ["zh-TW", "zh-HK", "zh-MO"],
    scripts: ["Hant"],
  },
  {
    code: "ja",
    nativeName: "日本語",
    compactLabel: "日本語",
    direction: "ltr",
    aliases: [],
    scripts: [],
  },
  {
    code: "de",
    nativeName: "Deutsch",
    compactLabel: "DE",
    direction: "ltr",
    aliases: [],
    scripts: [],
  },
  {
    code: "fr",
    nativeName: "Français",
    compactLabel: "FR",
    direction: "ltr",
    aliases: [],
    scripts: [],
  },
  {
    code: "es",
    nativeName: "Español",
    compactLabel: "ES",
    direction: "ltr",
    aliases: [],
    scripts: [],
  },
  {
    code: "pt-BR",
    nativeName: "Português (Brasil)",
    compactLabel: "PT-BR",
    direction: "ltr",
    aliases: ["pt"],
    scripts: [],
  },
  {
    code: "ko",
    nativeName: "한국어",
    compactLabel: "한국어",
    direction: "ltr",
    aliases: [],
    scripts: [],
  },
  {
    code: "ru",
    nativeName: "Русский",
    compactLabel: "RU",
    direction: "ltr",
    aliases: [],
    scripts: [],
  },
] as const satisfies readonly LocaleDefinition[];

export type SupportedLanguage = (typeof SUPPORTED_LOCALES)[number]["code"];
export type LocaleDirection = (typeof SUPPORTED_LOCALES)[number]["direction"];

export const DEFAULT_LANGUAGE = "zh-CN" satisfies SupportedLanguage;
export const FALLBACK_LANGUAGE = DEFAULT_LANGUAGE;

export const SUPPORTED_LANGUAGES = SUPPORTED_LOCALES.map(
  ({ code }) => code,
) as SupportedLanguage[];

const localeDefinitions: readonly LocaleDefinition[] = SUPPORTED_LOCALES;

export function isSupportedLanguage(
  language: unknown,
): language is SupportedLanguage {
  return (
    typeof language === "string" &&
    SUPPORTED_LANGUAGES.includes(language as SupportedLanguage)
  );
}

export function localeDefinition(language: SupportedLanguage) {
  return localeDefinitions.find(({ code }) => code === language)!;
}

function findSupportedLanguage(
  language: string | null | undefined,
): SupportedLanguage | undefined {
  if (!language) return undefined;
  let canonical = language.replace(/_/g, "-");
  try {
    canonical = Intl.getCanonicalLocales(canonical)[0] ?? canonical;
  } catch {
    // Invalid or legacy values can still be compared case-insensitively.
  }

  const exact = SUPPORTED_LOCALES.find(
    ({ code, aliases }) =>
      code.toLowerCase() === canonical.toLowerCase() ||
      aliases.some((alias) => alias.toLowerCase() === canonical.toLowerCase()),
  );
  if (exact) return exact.code;

  let baseLanguage = canonical.split("-")[0]?.toLowerCase();
  let script: string | undefined;
  try {
    const locale = new Intl.Locale(canonical);
    baseLanguage = locale.language.toLowerCase();
    script = locale.script ?? locale.maximize().script;
  } catch {
    // The first BCP 47 segment is a sufficient fallback for legacy values.
  }

  const scriptMatch = localeDefinitions.find(
    ({ code, scripts }) =>
      code.split("-")[0]?.toLowerCase() === baseLanguage &&
      script !== undefined &&
      scripts.includes(script),
  );
  if (scriptMatch) return scriptMatch.code as SupportedLanguage;

  return localeDefinitions.find(
    ({ code }) => code.split("-")[0]?.toLowerCase() === baseLanguage,
  )?.code as SupportedLanguage | undefined;
}

export function normalizeLanguage(
  language: string | null | undefined,
): SupportedLanguage {
  return findSupportedLanguage(language) ?? DEFAULT_LANGUAGE;
}

export function initialLanguage(): SupportedLanguage {
  try {
    const stored = readMigratedStorageItem(
      window.localStorage,
      LANGUAGE_STORAGE_KEY,
      LEGACY_STORAGE_KEYS.language,
    );
    const storedLanguage = findSupportedLanguage(stored);
    if (storedLanguage) return storedLanguage;

    const browserLanguages = window.navigator.languages?.length
      ? window.navigator.languages
      : [window.navigator.language];
    for (const browserLanguage of browserLanguages) {
      const supported = findSupportedLanguage(browserLanguage);
      if (supported) return supported;
    }
    return DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function persistLanguage(language: string): void {
  const normalized = normalizeLanguage(language);
  if (typeof document !== "undefined") {
    document.documentElement.lang = normalized;
    document.documentElement.dir = localeDefinition(normalized).direction;
  }
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
  } catch {
    // Language switching remains available for the current session.
  }
}
