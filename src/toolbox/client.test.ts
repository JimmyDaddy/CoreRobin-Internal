import { describe, expect, it } from "vitest";

import { selectNewerToolboxSnapshot } from "./client";
import type { ToolboxSnapshot } from "./contracts";

describe("selectNewerToolboxSnapshot", () => {
  it("accepts the initial snapshot, then only same-service non-stale revisions", () => {
    const initial = snapshot("service-a", 4);
    expect(selectNewerToolboxSnapshot(null, initial)).toBe(initial);

    expect(selectNewerToolboxSnapshot(initial, snapshot("service-a", 3))).toBe(initial);
    expect(selectNewerToolboxSnapshot(initial, snapshot("service-b", 99))).toBe(initial);

    const newer = snapshot("service-a", 5);
    expect(selectNewerToolboxSnapshot(initial, newer)).toBe(newer);
  });
});

function snapshot(serviceInstanceId: string, revision: number) {
  return {
    contractVersion: "toolbox-v1" as const,
    serviceInstanceId,
    revision,
    resetEpoch: 0,
    sessions: [],
    resources: [],
    jobs: [],
    capabilities: {},
  } as unknown as ToolboxSnapshot;
}
