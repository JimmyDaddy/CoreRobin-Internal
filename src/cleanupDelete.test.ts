import { describe, expect, it } from "vitest";

import {
  createMockCleanupDeleteLease,
  executeMockCleanupDelete,
  releaseMockCleanupDeleteLease,
} from "./mockData";

describe("cleanup permanent deletion confirmation mock", () => {
  it("binds the confirmed paths and consumes the lease once", () => {
    const lease = createMockCleanupDeleteLease({
      paths: ["~/Downloads/archive.zip"],
      scanSampledAtMs: Date.now(),
      expectedTargets: [{
        path: "~/Downloads/archive.zip",
        logicalSizeBytes: 1,
        allocatedSizeBytes: 4_096,
        itemCount: 1,
      }],
      mode: "trash",
    });

    expect(lease.paths).toEqual(["~/Downloads/archive.zip"]);
    expect(executeMockCleanupDelete({ leaseId: lease.id })).toEqual({
      deleted: [{ path: "~/Downloads/archive.zip", deletedBytes: 0 }],
      deletedBytes: 0,
      failed: [],
      cancelled: false,
      interruptedPath: null,
    });
    expect(() => executeMockCleanupDelete({ leaseId: lease.id })).toThrow(
      expect.objectContaining({ code: "cleanup_confirmation_unavailable" }),
    );
  });

  it("cannot execute a released confirmation", () => {
    const lease = createMockCleanupDeleteLease({
      paths: ["~/Library/Caches/example"],
      scanSampledAtMs: Date.now(),
      expectedTargets: [{
        path: "~/Library/Caches/example",
        logicalSizeBytes: 1,
        allocatedSizeBytes: 4_096,
        itemCount: 1,
      }],
      mode: "permanent",
    });

    releaseMockCleanupDeleteLease({ leaseId: lease.id });

    expect(() => executeMockCleanupDelete({ leaseId: lease.id })).toThrow(
      expect.objectContaining({ code: "cleanup_confirmation_unavailable" }),
    );
  });
});
