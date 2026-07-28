/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";

import {
  APPLICATION_IMPACT_HISTORY_BUCKET_MS,
  APPLICATION_IMPACT_HISTORY_MAX_APPS,
  applicationImpactHistoryInRange,
  mergeApplicationImpactHistory,
  parseApplicationImpactHistory,
  saveApplicationImpactHistory,
  serializeApplicationImpactHistory,
  summarizeApplicationImpactHistory,
} from "./applicationImpactHistory";
import type { ApplicationImpact } from "./diagnosis";

describe("application impact history", () => {
  it("aggregates stable application identities into five-minute buckets", () => {
    const sampledAtMs = 20 * APPLICATION_IMPACT_HISTORY_BUCKET_MS;
    const first = application("alice:editor", "Editor", 20, 1_000, 2_000);
    const second = application("alice:editor", "Editor", 40, 3_000, 4_000);

    const points = mergeApplicationImpactHistory(
      mergeApplicationImpactHistory([], [first], sampledAtMs),
      [second],
      sampledAtMs + 30_000,
    );

    expect(points).toHaveLength(1);
    expect(points[0]?.applications[0]).toMatchObject({
      name: "Editor",
      sampleCount: 2,
      averageCpuPercent: 30,
      peakCpuPercent: 40,
      averageMemoryBytes: 2_000,
      peakDiskBytesPerSecond: 4_000,
    });
    expect(points[0]?.applications[0]?.applicationId).toMatch(/^app-[0-9a-f]{32}$/);
    expect(points[0]?.applications[0]?.applicationId).not.toContain("alice");
  });

  it("bounds each bucket and filters summary ranges", () => {
    const now = 200 * APPLICATION_IMPACT_HISTORY_BUCKET_MS;
    const applications = Array.from({ length: 20 }, (_, index) =>
      application(`user:app-${index}`, `App ${index}`, index, index, index)
    );
    const points = mergeApplicationImpactHistory([], applications, now);
    const oldPoint = mergeApplicationImpactHistory(
      [],
      [application("user:old", "Old", 100, 100, 100)],
      now - 2 * 60 * 60 * 1_000,
    )[0]!;

    expect(points[0]?.applications).toHaveLength(
      APPLICATION_IMPACT_HISTORY_MAX_APPS,
    );
    expect(applicationImpactHistoryInRange([...points, oldPoint], 1, now))
      .toEqual(points);
    expect(summarizeApplicationImpactHistory(points)[0]?.name).toBe("App 19");
  });

  it("uses a compact dictionary payload and round trips without repeating names", () => {
    const sampledAtMs = 20 * APPLICATION_IMPACT_HISTORY_BUCKET_MS;
    const points = [
      ...mergeApplicationImpactHistory(
        [],
        [application("alice:editor", "Editor", 20, 1_000, 2_000)],
        sampledAtMs,
      ),
      ...mergeApplicationImpactHistory(
        [],
        [application("alice:editor", "Editor", 30, 2_000, 3_000)],
        sampledAtMs + APPLICATION_IMPACT_HISTORY_BUCKET_MS,
      ),
    ];
    const payload = serializeApplicationImpactHistory(points);

    expect(payload.match(/Editor/g)).toHaveLength(1);
    expect(parseApplicationImpactHistory(payload)).toEqual(points);
  });

  it("reports storage failures instead of silently claiming persistence", () => {
    const storage = {
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    } as unknown as Storage;

    expect(saveApplicationImpactHistory([], storage)).toMatchObject({
      succeeded: false,
      error: "quota",
    });
  });
});

function application(
  id: string,
  name: string,
  cpuPercent: number,
  memoryBytes: number,
  diskBytesPerSecond: number,
): ApplicationImpact {
  return {
    id,
    name,
    processCount: 1,
    cpuPercent,
    memoryBytes,
    diskBytesPerSecond,
    systemComponent: false,
    representativeIdentity: id,
    actionIdentity: id,
    memberIdentities: [id],
    iconProcess: { pid: 1, snapshotStartTime: 1, snapshotBirthToken: "1" },
  };
}
