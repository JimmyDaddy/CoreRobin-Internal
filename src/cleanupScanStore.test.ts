import { afterEach, describe, expect, it, vi } from "vitest";

import { getMockCleanupScan } from "./mockData";
import {
  CLEANUP_SCAN_RETENTION_MS,
  CLEANUP_SCAN_STALE_AFTER_MS,
  CLEANUP_SCAN_STORAGE_KEY,
  clearStoredCleanupScan,
  loadStoredCleanupScan,
  parseStoredCleanupScan,
  saveCleanupScan,
} from "./cleanupScanStore";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cleanup scan persistence", () => {
  it("restores a recent scan as a cached snapshot", () => {
    const snapshot = getMockCleanupScan();
    const now = 10_000;
    const parsed = parseStoredCleanupScan(JSON.stringify({
      version: 1,
      savedAtMs: now - 500,
      snapshot,
    }), now);

    expect(parsed).toEqual({ snapshot, status: "cached" });
  });

  it("keeps an older result visible with an expired status", () => {
    const snapshot = getMockCleanupScan();
    const now = CLEANUP_SCAN_STALE_AFTER_MS + 2_000;
    expect(parseStoredCleanupScan(JSON.stringify({
      version: 1,
      savedAtMs: 1_000,
      snapshot,
    }), now)?.status).toBe("expired");
  });

  it("uses the current guarded cleanup capability for older retained scans", () => {
    const snapshot = { ...getMockCleanupScan(), deletionAvailable: false };
    const parsed = parseStoredCleanupScan(JSON.stringify({
      version: 1,
      savedAtMs: 9_500,
      snapshot,
    }), 10_000);

    expect(parsed?.snapshot.deletionAvailable).toBe(true);
  });

  it("keeps legacy retained maps usable without inventing application activity", () => {
    const snapshot = getMockCleanupScan();
    const { installedApplications: _applications, applicationInventoryAvailable: _available, ...legacy } = snapshot;
    const parsed = parseStoredCleanupScan(JSON.stringify({
      version: 1,
      savedAtMs: 9_500,
      snapshot: legacy,
    }), 10_000);

    expect(parsed?.snapshot.installedApplications).toEqual([]);
    expect(parsed?.snapshot.applicationInventoryAvailable).toBe(false);
  });

  it("drops invalid and retention-expired payloads", () => {
    const snapshot = getMockCleanupScan();
    const now = CLEANUP_SCAN_RETENTION_MS + 2_000;
    expect(parseStoredCleanupScan("not-json", now)).toBeNull();
    expect(parseStoredCleanupScan(JSON.stringify({
      version: 1,
      savedAtMs: 1_000,
      snapshot,
    }), now)).toBeNull();
  });

  it("saves and loads the completed snapshot", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
      },
    });
    const snapshot = getMockCleanupScan();
    saveCleanupScan(snapshot, 20_000);

    expect(values.has(CLEANUP_SCAN_STORAGE_KEY)).toBe(true);
    expect(loadStoredCleanupScan(21_000)?.snapshot).toEqual(snapshot);
    clearStoredCleanupScan();
    expect(values.has(CLEANUP_SCAN_STORAGE_KEY)).toBe(false);
  });
});
