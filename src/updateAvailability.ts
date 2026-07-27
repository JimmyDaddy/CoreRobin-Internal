import {
  compareStableVersions,
  CURRENT_APP_VERSION,
} from "./productSupport";

export const AVAILABLE_UPDATE_VERSION_STORAGE_KEY =
  "core-robin.update-check.available-version.v1";

export function loadAvailableUpdateVersion(): string | null {
  try {
    const cachedVersion = window.localStorage.getItem(
      AVAILABLE_UPDATE_VERSION_STORAGE_KEY,
    );
    return cachedVersion &&
        compareStableVersions(cachedVersion, CURRENT_APP_VERSION) > 0
      ? cachedVersion
      : null;
  } catch {
    return null;
  }
}

export function saveAvailableUpdateVersion(version: string | null): void {
  try {
    if (version) {
      window.localStorage.setItem(
        AVAILABLE_UPDATE_VERSION_STORAGE_KEY,
        version,
      );
    } else {
      window.localStorage.removeItem(
        AVAILABLE_UPDATE_VERSION_STORAGE_KEY,
      );
    }
  } catch {
    // The live update state remains available for the current session.
  }
}
