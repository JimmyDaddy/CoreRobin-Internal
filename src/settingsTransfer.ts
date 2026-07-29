import {
  parseAppSettings,
  type AppSettings,
} from "./settings";

export const SETTINGS_TRANSFER_FORMAT = "core-robin-preferences";

export interface SettingsTransferDocument {
  format: typeof SETTINGS_TRANSFER_FORMAT;
  schemaVersion: 1;
  exportedAt: string;
  preferences: AppSettings;
}

export interface SettingsTransferPreview {
  document: SettingsTransferDocument;
  changedKeys: Array<keyof Omit<AppSettings, "version">>;
  ruleCount: number;
}

export function createSettingsTransferDocument(
  settings: AppSettings,
  now = new Date(),
): SettingsTransferDocument {
  return {
    format: SETTINGS_TRANSFER_FORMAT,
    schemaVersion: 1,
    exportedAt: now.toISOString(),
    preferences: parseAppSettings(
      JSON.stringify(settings),
      settings.language,
    ),
  };
}

export function parseSettingsTransferDocument(
  serialized: string,
  current: AppSettings,
): SettingsTransferPreview {
  const value = JSON.parse(serialized) as unknown;
  if (
    !isRecord(value)
    || value.format !== SETTINGS_TRANSFER_FORMAT
    || value.schemaVersion !== 1
    || typeof value.exportedAt !== "string"
    || !isRecord(value.preferences)
    || value.preferences.version !== 1
  ) {
    throw new Error("settings_transfer_invalid");
  }
  const preferences = parseAppSettings(
    JSON.stringify(value.preferences),
    current.language,
  );
  const changedKeys = (Object.keys(preferences) as Array<keyof AppSettings>)
    .filter((key): key is keyof Omit<AppSettings, "version"> =>
      key !== "version"
      && JSON.stringify(preferences[key]) !== JSON.stringify(current[key]));
  return {
    document: {
      format: SETTINGS_TRANSFER_FORMAT,
      schemaVersion: 1,
      exportedAt: value.exportedAt,
      preferences,
    },
    changedKeys,
    ruleCount: preferences.applicationWatchRules.length,
  };
}

export function settingsUpdateFromTransfer(
  document: SettingsTransferDocument,
): Partial<Omit<AppSettings, "version">> {
  return Object.fromEntries(
    Object.entries(document.preferences)
      .filter(([key]) => key !== "version"),
  ) as Partial<Omit<AppSettings, "version">>;
}

export function serializeSettingsTransferDocument(
  document: SettingsTransferDocument,
): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
