import {
  LEGACY_STORAGE_KEYS,
  readMigratedStorageItem,
} from "./storageMigration";

export const APP_SETTINGS_STORAGE_KEY = "status-orbit.settings.v1";

export type InterfaceScale = "comfortable" | "large";

export interface AppAppearance {
  interfaceScale: InterfaceScale;
  reduceMotion: boolean;
}

const DEFAULT_APPEARANCE: AppAppearance = {
  interfaceScale: "comfortable",
  reduceMotion: false,
};

export function loadAppAppearance(): AppAppearance {
  try {
    const serialized = readMigratedStorageItem(
      window.localStorage,
      APP_SETTINGS_STORAGE_KEY,
      LEGACY_STORAGE_KEYS.settings,
    );
    if (!serialized) return DEFAULT_APPEARANCE;

    const value = JSON.parse(serialized) as unknown;
    if (!isRecord(value) || value.version !== 1) return DEFAULT_APPEARANCE;
    return {
      interfaceScale: value.interfaceScale === "large" ? "large" : "comfortable",
      reduceMotion: value.reduceMotion === true,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function applyAppAppearance(
  appearance: AppAppearance,
  root: HTMLElement = document.documentElement,
): void {
  root.dataset.interfaceScale = appearance.interfaceScale;
  root.dataset.reduceMotion = appearance.reduceMotion ? "true" : "false";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
