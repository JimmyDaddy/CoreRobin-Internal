import { describe, expect, it } from "vitest";

import {
  createMockStartupManagementLease,
  executeMockStartupManagement,
  getMockStartupItems,
  releaseMockStartupManagementLease,
} from "./mockData";

describe("startup management mock contract", () => {
  it("uses single-use confirmations and preserves a reversible state", () => {
    const itemId = "launch-agent:spotify";
    const disable = createMockStartupManagementLease({ itemId, action: "disable" });
    expect(executeMockStartupManagement({ leaseId: disable.id })).toMatchObject({
      itemId,
      enabled: false,
      verification: "complete",
      relatedItemCount: 0,
      unresolvedSourceCount: 0,
      requiresSystemSettings: false,
    });
    expect(getMockStartupItems().items.find(({ id }) => id === itemId)?.enabled).toBe(false);
    expect(() => executeMockStartupManagement({ leaseId: disable.id })).toThrow();

    const enable = createMockStartupManagementLease({ itemId, action: "enable" });
    expect(executeMockStartupManagement({ leaseId: enable.id }).enabled).toBe(true);
    expect(getMockStartupItems().items.find(({ id }) => id === itemId)?.enabled).toBe(true);
  });

  it("release prevents a prepared action and system items stay protected", () => {
    const lease = createMockStartupManagementLease({
      itemId: "launch-agent:dropbox",
      action: "disable",
    });
    releaseMockStartupManagementLease({ leaseId: lease.id });
    expect(() => executeMockStartupManagement({ leaseId: lease.id })).toThrow();
    expect(() => createMockStartupManagementLease({
      itemId: "launch-daemon:apple",
      action: "disable",
    })).toThrow();
  });
});
