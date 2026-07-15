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
    });

    releaseMockCleanupDeleteLease({ leaseId: lease.id });

    expect(() => executeMockCleanupDelete({ leaseId: lease.id })).toThrow(
      expect.objectContaining({ code: "cleanup_confirmation_unavailable" }),
    );
  });
});
