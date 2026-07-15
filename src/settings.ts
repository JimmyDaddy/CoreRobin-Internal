import {
  APP_SETTINGS_STORAGE_KEY,
  type InterfaceScale,
} from "./appearance";
import type { SupportedLanguage } from "./language";
import type { HistoryRetentionDays } from "./historyStore";
import type { ResourceAlertResource } from "./resourceAlerts";
import type { ProcessViewMode } from "./types";
import {
  LEGACY_STORAGE_KEYS,
  readMigratedStorageItem,
} from "./storageMigration";

export {
  APP_SETTINGS_STORAGE_KEY,
  applyAppAppearance,
  type InterfaceScale,
} from "./appearance";
export const SYSTEM_SAMPLE_INTERVAL_OPTIONS = [500, 1_000, 2_000, 5_000] as const;
export const CONNECTION_REFRESH_INTERVAL_OPTIONS = [3_000, 5_000, 10_000, 30_000] as const;

export type UsageThresholds = readonly [number, number, number];
export type ExperienceMode = "simple" | "professional";

export interface AppSettings {
  version: 1;
  language: SupportedLanguage;
  experienceMode: ExperienceMode;
  systemSampleIntervalMs: number;
  connectionRefreshIntervalMs: number;
  usageThresholds: UsageThresholds;
  defaultProcessView: ProcessViewMode;
  historyPersistenceEnabled: boolean;
  historyApplicationNamesEnabled: boolean;
  historyRetentionDays: HistoryRetentionDays;
  desktopNotificationsEnabled: boolean;
  mutedNotificationResources: ResourceAlertResource[];
  interfaceScale: InterfaceScale;
  reduceMotion: boolean;
  companionAlwaysOnTop: boolean;
  companionShowOnStartup: boolean;
}

export function defaultAppSettings(
  language: SupportedLanguage = "zh-CN",
): AppSettings {
  return {
    version: 1,
    language,
    experienceMode: "simple",
    systemSampleIntervalMs: 1_000,
    connectionRefreshIntervalMs: 5_000,
    usageThresholds: [35, 65, 85],
    defaultProcessView: "flat",
    historyPersistenceEnabled: true,
    historyApplicationNamesEnabled: false,
    historyRetentionDays: 7,
    desktopNotificationsEnabled: false,
    mutedNotificationResources: [],
    interfaceScale: "comfortable",
    reduceMotion: false,
    companionAlwaysOnTop: false,
    companionShowOnStartup: false,
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
      experienceMode: isExperienceMode(value.experienceMode)
        ? value.experienceMode
        : fallback.experienceMode,
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
      historyPersistenceEnabled:
        typeof value.historyPersistenceEnabled === "boolean"
          ? value.historyPersistenceEnabled
          : fallback.historyPersistenceEnabled,
      historyApplicationNamesEnabled:
        typeof value.historyApplicationNamesEnabled === "boolean"
          ? value.historyApplicationNamesEnabled
          : fallback.historyApplicationNamesEnabled,
      historyRetentionDays: isHistoryRetentionDays(value.historyRetentionDays)
        ? value.historyRetentionDays
        : fallback.historyRetentionDays,
      desktopNotificationsEnabled:
        typeof value.desktopNotificationsEnabled === "boolean"
          ? value.desktopNotificationsEnabled
          : fallback.desktopNotificationsEnabled,
      mutedNotificationResources: isNotificationResourceArray(value.mutedNotificationResources)
        ? value.mutedNotificationResources
        : fallback.mutedNotificationResources,
      interfaceScale: isInterfaceScale(value.interfaceScale)
        ? value.interfaceScale
        : fallback.interfaceScale,
      reduceMotion: typeof value.reduceMotion === "boolean"
        ? value.reduceMotion
        : fallback.reduceMotion,
      companionAlwaysOnTop: typeof value.companionAlwaysOnTop === "boolean"
        ? value.companionAlwaysOnTop
        : fallback.companionAlwaysOnTop,
      companionShowOnStartup: typeof value.companionShowOnStartup === "boolean"
        ? value.companionShowOnStartup
        : fallback.companionShowOnStartup,
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
      readMigratedStorageItem(
        window.localStorage,
        APP_SETTINGS_STORAGE_KEY,
        LEGACY_STORAGE_KEYS.settings,
      ),
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

function isExperienceMode(value: unknown): value is ExperienceMode {
  return value === "simple" || value === "professional";
}

function isInterfaceScale(value: unknown): value is InterfaceScale {
  return value === "comfortable" || value === "large";
}

function isProcessViewMode(value: unknown): value is ProcessViewMode {
  return value === "flat" || value === "tree";
}

function isHistoryRetentionDays(value: unknown): value is HistoryRetentionDays {
  return value === 1 || value === 7 || value === 30;
}

function isNotificationResourceArray(value: unknown): value is ResourceAlertResource[] {
  return Array.isArray(value) && value.every((resource) =>
    resource === "cpu" || resource === "memory" || resource === "volume"
  );
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
