import { describe, expect, it } from "vitest";

import type { CleanupMapNode } from "./cleanupMap";
import {
  applyRefreshedCleanupTargets,
  buildCleanupDeleteLeaseRequest,
  cleanupLeaseCanExecute,
} from "./cleanupDeleteFreshness";

const target: CleanupMapNode = {
  id: "downloads/archive",
  name: "archive",
  path: "~/Downloads/archive",
  sizeBytes: 4_096,
  logicalSizeBytes: 1_000,
  allocatedSizeBytes: 4_096,
  itemCount: 1,
  safety: "review",
  kind: "folder",
  hasChildren: true,
  children: [],
};

describe("cleanup deletion freshness", () => {
  it("binds displayed evidence and scan time into the lease request", () => {
    expect(buildCleanupDeleteLeaseRequest([target], 123, "trash")).toEqual({
      paths: ["~/Downloads/archive"],
      scanSampledAtMs: 123,
      expectedTargets: [{
        path: "~/Downloads/archive",
        logicalSizeBytes: 1_000,
        allocatedSizeBytes: 4_096,
        itemCount: 1,
      }],
      mode: "trash",
    });
  });

  it("rebuilds dialog items by stable path with refreshed evidence", () => {
    const refreshed = applyRefreshedCleanupTargets(
      [target],
      [{
        path: "~/Downloads/archive",
        logicalSizeBytes: 2_000,
        allocatedSizeBytes: 8_192,
        itemCount: 2,
      }],
      [],
      [],
    );
    expect(refreshed).toEqual([expect.objectContaining({
      id: target.id,
      path: target.path,
      sizeBytes: 8_192,
      logicalSizeBytes: 2_000,
      allocatedSizeBytes: 8_192,
      itemCount: 2,
    })]);
    expect(refreshed?.[0]).not.toBe(target);
  });

  it("keeps missing and inaccessible paths in a partial best-effort confirmation", () => {
    expect(applyRefreshedCleanupTargets([target], [], [target.path!], [])).toEqual([
      expect.objectContaining({
        path: target.path,
        sizeBytes: 0,
        logicalSizeBytes: 0,
        allocatedSizeBytes: 0,
        itemCount: 0,
        hasChildren: false,
      }),
    ]);
    expect(applyRefreshedCleanupTargets([target], [], [], [target.path!])).toEqual([target]);
  });

  it("rejects unexplained incomplete refreshes and non-executable leases", () => {
    expect(applyRefreshedCleanupTargets([target], [], [], [])).toBeNull();
    expect(cleanupLeaseCanExecute(null)).toBe(false);
    expect(cleanupLeaseCanExecute({
      id: "refresh-only",
      mode: "permanent",
      paths: [target.path!],
      missingPaths: [],
      unavailablePaths: [],
      changedPaths: [target.path!],
      refreshedTargets: [],
      executable: false,
      refreshedAtMs: 200,
    })).toBe(false);
  });
});
