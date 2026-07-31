import { describe, expect, it } from "vitest";

import {
  reconcileCleanupNodeAfterDeletion,
  reconcileCleanupScanAfterDeletion,
} from "./cleanupScanStore";
import { getMockCleanupScan } from "./mockData";

describe("cleanup scan reconciliation", () => {
  it("removes an external path from the visible tree and location totals", () => {
    const snapshot = getMockCleanupScan();
    const target = snapshot.root.children[0];
    if (!target.path) throw new Error("fixture path is required");

    const updated = reconcileCleanupScanAfterDeletion(snapshot, [{
      path: target.path,
      logicalSizeBytes: target.logicalSizeBytes,
      allocatedSizeBytes: target.allocatedSizeBytes,
      itemCount: target.itemCount,
    }]);

    expect(updated.root.children.some((child) => child.path === target.path)).toBe(false);
    expect(updated.root.allocatedSizeBytes).toBeLessThanOrEqual(
      snapshot.root.allocatedSizeBytes,
    );
  });

  it("ignores unrelated paths without changing node identity", () => {
    const snapshot = getMockCleanupScan();
    const result = reconcileCleanupNodeAfterDeletion(snapshot.root, [{
      path: "/not/inside/the/scan",
      logicalSizeBytes: 1,
      allocatedSizeBytes: 1,
      itemCount: 1,
    }]);

    expect(result).toBe(snapshot.root);
  });
});
