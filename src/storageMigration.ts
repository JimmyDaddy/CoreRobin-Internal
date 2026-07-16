type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const LEGACY_STORAGE_KEYS = {
  settings: ["status-orbit.settings.v1", "pulse.settings.v1"],
  language: ["status-orbit.language.v1", "pulse.language.v1"],
  processExplorer: [
    "status-orbit.process-explorer.preferences.v1",
    "pulse.process-explorer.preferences.v1",
  ],
  resourceHistory: [
    "status-orbit.resource-history.v1",
    "pulse.resource-history.v1",
  ],
  resourceAlerts: [
    "status-orbit.resource-alert-events.v1",
    "pulse.resource-alert-events.v1",
  ],
  cleanupScan: [
    "status-orbit.cleanup-scan.v5",
    "status-orbit.cleanup-scan.v4",
    "status-orbit.cleanup-scan.v3",
    "status-orbit.cleanup-scan.v2",
    "status-orbit.cleanup-scan.v1",
    "pulse.cleanup-scan.v1",
  ],
  desktopNotificationLog: [
    "status-orbit.desktop-notification-log.v1",
    "pulse.desktop-notification-log.v1",
  ],
  userActionHistory: ["status-orbit.user-action-history.v1"],
  cleanupMapMode: ["status-orbit.cleanup-map-mode.v1"],
  companionPosition: ["status-orbit.companion-position.v1"],
} as const;

export function readMigratedStorageItem(
  storage: StorageLike,
  currentKey: string,
  legacyKeys: readonly string[],
): string | null {
  const current = storage.getItem(currentKey);
  if (current !== null) return current;

  for (const legacyKey of legacyKeys) {
    const legacy = storage.getItem(legacyKey);
    if (legacy === null) continue;

    try {
      storage.setItem(currentKey, legacy);
      storage.removeItem(legacyKey);
    } catch {
      // Returning the legacy value still preserves the user's preferences for
      // this session when the WebView allows reads but blocks writes.
    }
    return legacy;
  }

  return null;
}

export function removeStorageItems(
  storage: StorageLike,
  currentKey: string,
  legacyKeys: readonly string[],
): void {
  storage.removeItem(currentKey);
  for (const legacyKey of legacyKeys) storage.removeItem(legacyKey);
}
