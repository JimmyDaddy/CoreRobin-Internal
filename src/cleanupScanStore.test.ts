import { afterEach, describe, expect, it, vi } from "vitest";

import { getMockCleanupScan } from "./mockData";
import {
  CLEANUP_SCAN_RETENTION_MS,
  CLEANUP_SCAN_STALE_AFTER_MS,
  CLEANUP_SCAN_STORAGE_KEY,
  clearStoredCleanupScan,
  parseStoredCleanupScan,
} from "./cleanupScanStore";
import { LEGACY_STORAGE_KEYS } from "./storageMigration";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cleanup scan persistence", () => {
  it("restores a recent scan as a cached snapshot", () => {
    const snapshot = getMockCleanupScan();
    const now = 10_000;
    const parsed = parseStoredCleanupScan(JSON.stringify({
      version: 3,
      savedAtMs: now - 500,
      snapshot,
    }), now);

    expect(parsed).toEqual({ snapshot, status: "cached" });
  });

  it("keeps an older result visible with an expired status", () => {
    const snapshot = getMockCleanupScan();
    const now = CLEANUP_SCAN_STALE_AFTER_MS + 2_000;
    expect(parseStoredCleanupScan(JSON.stringify({
      version: 3,
      savedAtMs: 1_000,
      snapshot,
    }), now)?.status).toBe("expired");
  });

  it("uses the current guarded cleanup capability for older retained scans", () => {
    const snapshot = { ...getMockCleanupScan(), deletionAvailable: false };
    const parsed = parseStoredCleanupScan(JSON.stringify({
      version: 3,
      savedAtMs: 9_500,
      snapshot,
    }), 10_000);

    expect(parsed?.snapshot.deletionAvailable).toBe(true);
  });

  it("keeps retained v3 maps usable without inventing application activity", () => {
    const snapshot = getMockCleanupScan();
    const { installedApplications: _applications, applicationInventoryAvailable: _available, ...legacy } = snapshot;
    const parsed = parseStoredCleanupScan(JSON.stringify({
      version: 3,
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
      version: 3,
      savedAtMs: 1_000,
      snapshot,
    }), now)).toBeNull();
  });

  it("rejects v2 maps whose unbounded trees can freeze the WebView", () => {
    expect(parseStoredCleanupScan(JSON.stringify({
      version: 2,
      savedAtMs: 9_500,
      snapshot: getMockCleanupScan(),
    }), 10_000)).toBeNull();
  });

  it("rejects v3 maps that cannot advertise lazily loadable folders", () => {
    const snapshot = getMockCleanupScan();
    delete (snapshot.locations[0].nodes[0] as { hasChildren?: boolean }).hasChildren;

    expect(parseStoredCleanupScan(JSON.stringify({
      version: 3,
      savedAtMs: 9_500,
      snapshot,
    }), 10_000)).toBeNull();
  });

  it("clears current and legacy WebView payloads", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        removeItem: (key: string) => values.delete(key),
      },
    });
    values.set(CLEANUP_SCAN_STORAGE_KEY, "current");
    for (const key of LEGACY_STORAGE_KEYS.cleanupScan) values.set(key, "legacy");
    clearStoredCleanupScan();
    expect(values.has(CLEANUP_SCAN_STORAGE_KEY)).toBe(false);
    for (const key of LEGACY_STORAGE_KEYS.cleanupScan) {
      expect(values.has(key)).toBe(false);
    }
  });
});
