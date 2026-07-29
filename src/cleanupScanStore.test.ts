import { afterEach, describe, expect, it, vi } from "vitest";

import { getMockCleanupScan } from "./mockData";
import {
  CLEANUP_SCAN_RETENTION_MS,
  CLEANUP_SCAN_STALE_AFTER_MS,
  CLEANUP_SCAN_STORAGE_KEY,
  clearStoredCleanupScan,
  parseStoredCleanupScan,
  reconcileCleanupNodeAfterDeletion,
  reconcileCleanupScanAfterDeletion,
  retainCleanupSubtree,
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
      version: 7,
      savedAtMs: now - 500,
      snapshot,
    }), now);

    expect(parsed).toEqual({ snapshot, status: "cached" });
  });

  it("keeps an older result visible with an expired status", () => {
    const snapshot = getMockCleanupScan();
    const now = CLEANUP_SCAN_STALE_AFTER_MS + 2_000;
    expect(parseStoredCleanupScan(JSON.stringify({
      version: 7,
      savedAtMs: 1_000,
      snapshot,
    }), now)?.status).toBe("expired");
  });

  it("does not invent cleanup capability for an older retained scan", () => {
    const snapshot = { ...getMockCleanupScan(), deletionAvailable: false };
    const parsed = parseStoredCleanupScan(JSON.stringify({
      version: 7,
      savedAtMs: 9_500,
      snapshot,
    }), 10_000);

    expect(parsed?.snapshot.deletionAvailable).toBe(false);
  });

  it("keeps retained v7 maps usable without inventing application activity", () => {
    const snapshot = getMockCleanupScan();
    const {
      installedApplications: _applications,
      applicationInventoryAvailable: _available,
      prefetchedSubtrees: _prefetchedSubtrees,
      subtreeCacheSavedAtMs: _subtreeCacheSavedAtMs,
      ...legacy
    } = snapshot;
    void _applications;
    void _available;
    void _prefetchedSubtrees;
    void _subtreeCacheSavedAtMs;
    const parsed = parseStoredCleanupScan(JSON.stringify({
      version: 7,
      savedAtMs: 9_500,
      snapshot: legacy,
    }), 10_000);

    expect(parsed?.snapshot.installedApplications).toEqual([]);
    expect(parsed?.snapshot.applicationInventoryAvailable).toBe(false);
    expect(parsed?.snapshot.prefetchedSubtrees).toEqual([]);
    expect(parsed?.snapshot.subtreeCacheSavedAtMs).toEqual({});
  });

  it("retains recently loaded subtrees and bounds the persistent cache", () => {
    let snapshot = getMockCleanupScan();
    for (let index = 0; index < 300; index += 1) {
      const id = `~/cached-${index}`;
      snapshot = retainCleanupSubtree(snapshot, {
        id,
        name: `cached-${index}`,
        path: id,
        sizeBytes: 1,
        logicalSizeBytes: 1,
        allocatedSizeBytes: 1,
        itemCount: 1,
        safety: "review",
        kind: "folder",
        hasChildren: true,
        children: [{
          id: `${id}/file`,
          name: "file",
          path: `${id}/file`,
          sizeBytes: 1,
          logicalSizeBytes: 1,
          allocatedSizeBytes: 1,
          itemCount: 1,
          safety: "review",
          kind: "file",
          hasChildren: false,
          children: [],
        }],
      }, index);
    }

    expect(snapshot.prefetchedSubtrees).toHaveLength(256);
    expect(snapshot.prefetchedSubtrees?.[0].id).toBe("~/cached-299");
    expect(snapshot.prefetchedSubtrees?.[255]?.id).toBe("~/cached-44");
    expect(Object.keys(snapshot.subtreeCacheSavedAtMs ?? {})).toHaveLength(256);
    expect(snapshot.subtreeCacheSavedAtMs?.["~/cached-299"]).toBe(299);
  });

  it("drops invalid and retention-expired payloads", () => {
    const snapshot = getMockCleanupScan();
    const now = CLEANUP_SCAN_RETENTION_MS + 2_000;
    expect(parseStoredCleanupScan("not-json", now)).toBeNull();
    expect(parseStoredCleanupScan(JSON.stringify({
      version: 7,
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

  it("rejects v3 maps because they do not contain a canonical path root", () => {
    expect(parseStoredCleanupScan(JSON.stringify({
      version: 3,
      savedAtMs: 9_500,
      snapshot: getMockCleanupScan(),
    }), 10_000)).toBeNull();
  });

  it("rejects v4 home-only maps after the scan scope expands to the system disk", () => {
    expect(parseStoredCleanupScan(JSON.stringify({
      version: 4,
      savedAtMs: 9_500,
      snapshot: getMockCleanupScan(),
    }), 10_000)).toBeNull();
  });

  it("rejects v6 maps whose saved protection decisions predate the current policy", () => {
    expect(parseStoredCleanupScan(JSON.stringify({
      version: 6,
      savedAtMs: 9_500,
      snapshot: getMockCleanupScan(),
    }), 10_000)).toBeNull();
  });

  it("rejects maps that cannot advertise lazily loadable folders", () => {
    const snapshot = getMockCleanupScan();
    delete (snapshot.locations[0].nodes[0] as { hasChildren?: boolean }).hasChildren;

    expect(parseStoredCleanupScan(JSON.stringify({
      version: 7,
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

  it("removes deleted nodes and updates every ancestor and location total", () => {
    const snapshot = getMockCleanupScan();
    const location = snapshot.locations.find((candidate) => candidate.kind === "downloads")!;
    const parent = location.nodes[0];
    const target = parent.children[0];
    const updated = reconcileCleanupScanAfterDeletion(snapshot, [{
      path: target.path!,
      logicalSizeBytes: target.logicalSizeBytes,
      allocatedSizeBytes: target.allocatedSizeBytes,
      itemCount: target.itemCount,
    }]);
    const updatedLocation = updated.locations.find((candidate) => candidate.kind === "downloads")!;
    const updatedParent = updatedLocation.nodes[0];

    expect(updatedLocation.sizeBytes).toBe(location.sizeBytes - target.allocatedSizeBytes);
    expect(updatedLocation.itemCount).toBe(location.itemCount - target.itemCount);
    expect(updatedParent.allocatedSizeBytes).toBe(parent.allocatedSizeBytes - target.allocatedSizeBytes);
    expect(updatedParent.logicalSizeBytes).toBe(parent.logicalSizeBytes - target.logicalSizeBytes);
    expect(updatedParent.itemCount).toBe(parent.itemCount - target.itemCount);
    expect(updatedParent.children.some((child) => child.path === target.path)).toBe(false);
    expect(updated.root.allocatedSizeBytes).toBe(snapshot.root.allocatedSizeBytes - target.allocatedSizeBytes);
    expect(updated.root.itemCount).toBe(snapshot.root.itemCount - target.itemCount);
  });

  it("updates a pruned ancestor even when the deleted child was loaded lazily", () => {
    const snapshot = getMockCleanupScan();
    const location = snapshot.locations.find((candidate) => candidate.kind === "developer_cache")!;
    const parent = { ...location.nodes[0], children: [] };
    const allocatedSizeBytes = Math.min(1_024, parent.allocatedSizeBytes);
    const target = {
      path: `${parent.path}/lazy-child`,
      logicalSizeBytes: allocatedSizeBytes,
      allocatedSizeBytes,
      itemCount: 1,
    };

    const updated = reconcileCleanupNodeAfterDeletion(parent, [target]);

    expect(updated?.allocatedSizeBytes).toBe(parent.allocatedSizeBytes - allocatedSizeBytes);
    expect(updated?.itemCount).toBe(parent.itemCount - 1);
  });

  it("removes large-file evidence beneath a deleted directory without changing scan age", () => {
    const snapshot = getMockCleanupScan();
    const file = snapshot.largestFiles[0];
    const parentPath = file.path.replace(/[/\\][^/\\]+$/, "");
    const updated = reconcileCleanupScanAfterDeletion(snapshot, [{
      path: parentPath,
      logicalSizeBytes: file.sizeBytes,
      allocatedSizeBytes: file.sizeBytes,
      itemCount: 1,
    }]);

    expect(updated.sampledAtMs).toBe(snapshot.sampledAtMs);
    expect(updated.largestFiles.some((candidate) => candidate.path === file.path)).toBe(false);
  });
});
