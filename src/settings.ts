import type { SupportedLanguage } from "./i18n";
import type { ProcessViewMode } from "./types";

export const APP_SETTINGS_STORAGE_KEY = "pulse.settings.v1";
export const SYSTEM_SAMPLE_INTERVAL_OPTIONS = [500, 1_000, 2_000, 5_000] as const;
export const CONNECTION_REFRESH_INTERVAL_OPTIONS = [3_000, 5_000, 10_000, 30_000] as const;

export type UsageThresholds = readonly [number, number, number];

export interface AppSettings {
  version: 1;
  language: SupportedLanguage;
  systemSampleIntervalMs: number;
  connectionRefreshIntervalMs: number;
  usageThresholds: UsageThresholds;
  defaultProcessView: ProcessViewMode;
}

export function defaultAppSettings(
  language: SupportedLanguage = "zh-CN",
): AppSettings {
  return {
    version: 1,
    language,
    systemSampleIntervalMs: 1_000,
    connectionRefreshIntervalMs: 5_000,
    usageThresholds: [35, 65, 85],
    defaultProcessView: "flat",
  };
}

export function parseAppSettings(
  serialized: string | null,
  language: SupportedLanguage = "zh-CN",
): AppSettings {
  const fallback = defaultAppSettings(language);
  if (!serialized) return fallback;

  try {
    const value = JSON.parse(serialized) as unknown;
    if (!isRecord(value) || value.version !== 1) return fallback;

    return {
      version: 1,
      language: isSupportedLanguage(value.language)
        ? value.language
        : fallback.language,
      systemSampleIntervalMs: isAllowedNumber(
        value.systemSampleIntervalMs,
        SYSTEM_SAMPLE_INTERVAL_OPTIONS,
      )
        ? value.systemSampleIntervalMs
        : fallback.systemSampleIntervalMs,
      connectionRefreshIntervalMs: isAllowedNumber(
        value.connectionRefreshIntervalMs,
        CONNECTION_REFRESH_INTERVAL_OPTIONS,
      )
        ? value.connectionRefreshIntervalMs
        : fallback.connectionRefreshIntervalMs,
      usageThresholds: isUsageThresholds(value.usageThresholds)
        ? value.usageThresholds
        : fallback.usageThresholds,
      defaultProcessView: isProcessViewMode(value.defaultProcessView)
        ? value.defaultProcessView
        : fallback.defaultProcessView,
    };
  } catch {
    return fallback;
  }
}

export function loadAppSettings(
  language: SupportedLanguage = "zh-CN",
): AppSettings {
  try {
    return parseAppSettings(
      window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY),
      language,
    );
  } catch {
    return defaultAppSettings(language);
  }
}

export function saveAppSettings(settings: AppSettings): void {
  try {
    const sanitized = parseAppSettings(
      JSON.stringify(settings),
      settings.language,
    );
    window.localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify(sanitized),
    );
  } catch {
    // Hardened WebViews may disable storage. Settings still apply in memory.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return value === "zh-CN" || value === "en";
}

function isProcessViewMode(value: unknown): value is ProcessViewMode {
  return value === "flat" || value === "tree";
}

function isAllowedNumber<const Values extends readonly number[]>(
  value: unknown,
  allowed: Values,
): value is Values[number] {
  return typeof value === "number" && allowed.includes(value);
}

function isUsageThresholds(value: unknown): value is UsageThresholds {
  if (!Array.isArray(value) || value.length !== 3) return false;
  const [moderate, high, critical] = value;
  return (
    typeof moderate === "number" &&
    typeof high === "number" &&
    typeof critical === "number" &&
    Number.isInteger(moderate) &&
    Number.isInteger(high) &&
    Number.isInteger(critical) &&
    moderate >= 1 &&
    moderate < high &&
    high < critical &&
    critical <= 100
  );
}
