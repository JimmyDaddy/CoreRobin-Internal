import {
  LEGACY_STORAGE_KEYS,
  readMigratedStorageItem,
} from "./storageMigration";

export const LANGUAGE_STORAGE_KEY = "status-orbit.language.v1";
export type SupportedLanguage = "zh-CN" | "en";

export function normalizeLanguage(
  language: string | null | undefined,
): SupportedLanguage {
  return language?.toLowerCase().startsWith("en") ? "en" : "zh-CN";
}

export function initialLanguage(): SupportedLanguage {
  try {
    const stored = readMigratedStorageItem(
      window.localStorage,
      LANGUAGE_STORAGE_KEY,
      LEGACY_STORAGE_KEYS.language,
    );
    if (stored) return normalizeLanguage(stored);
    return normalizeLanguage(window.navigator.language);
  } catch {
    return "zh-CN";
  }
}

export function persistLanguage(language: string): void {
  const normalized = normalizeLanguage(language);
  if (typeof document !== "undefined") {
    document.documentElement.lang = normalized;
  }
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, normalized);
  } catch {
    // Language switching remains available for the current session.
  }
}
