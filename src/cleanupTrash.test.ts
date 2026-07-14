import { describe, expect, it } from "vitest";

import {
  createMockCleanupTrashLease,
  executeMockCleanupTrash,
  releaseMockCleanupTrashLease,
} from "./mockData";

describe("cleanup trash confirmation mock", () => {
  it("binds the confirmed paths and consumes the lease once", () => {
    const lease = createMockCleanupTrashLease({
      paths: ["~/Downloads/archive.zip"],
      scanSampledAtMs: Date.now(),
    });

    expect(lease.paths).toEqual(["~/Downloads/archive.zip"]);
    expect(executeMockCleanupTrash({ leaseId: lease.id })).toEqual({
      movedPaths: ["~/Downloads/archive.zip"],
      failed: [],
    });
    expect(() => executeMockCleanupTrash({ leaseId: lease.id })).toThrow(
      expect.objectContaining({ code: "cleanup_confirmation_unavailable" }),
    );
  });

  it("cannot execute a released confirmation", () => {
    const lease = createMockCleanupTrashLease({
      paths: ["~/Library/Caches/example"],
      scanSampledAtMs: Date.now(),
    });

    releaseMockCleanupTrashLease({ leaseId: lease.id });

    expect(() => executeMockCleanupTrash({ leaseId: lease.id })).toThrow(
      expect.objectContaining({ code: "cleanup_confirmation_unavailable" }),
    );
  });
});
