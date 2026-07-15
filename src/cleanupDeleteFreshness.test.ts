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
    expect(buildCleanupDeleteLeaseRequest([target], 123)).toEqual({
      paths: ["~/Downloads/archive"],
      scanSampledAtMs: 123,
      expectedTargets: [{
        path: "~/Downloads/archive",
        logicalSizeBytes: 1_000,
        allocatedSizeBytes: 4_096,
        itemCount: 1,
      }],
    });
  });

  it("rebuilds dialog items by stable path with refreshed evidence", () => {
    const refreshed = applyRefreshedCleanupTargets([target], [{
      path: "~/Downloads/archive",
      logicalSizeBytes: 2_000,
      allocatedSizeBytes: 8_192,
      itemCount: 2,
    }]);
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

  it("rejects incomplete refreshes and non-executable leases", () => {
    expect(applyRefreshedCleanupTargets([target], [])).toBeNull();
    expect(cleanupLeaseCanExecute(null)).toBe(false);
    expect(cleanupLeaseCanExecute({
      id: "refresh-only",
      paths: [target.path!],
      changedPaths: [target.path!],
      refreshedTargets: [],
      executable: false,
      refreshedAtMs: 200,
      expiresAtMs: 300,
    })).toBe(false);
  });
});
