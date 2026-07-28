import { describe, expect, it } from "vitest";

import {
  NETWORK_QUALITY_HISTORY_BUCKET_MS,
  mergeNetworkQualityHistory,
  networkQualityFailurePercent,
} from "./networkQualityHistory";
import type { NetworkQualityResult } from "./types";

describe("network quality history", () => {
  it("aggregates samples into five-minute buckets with honest TCP failure counts", () => {
    const first = qualityResult(10 * NETWORK_QUALITY_HISTORY_BUCKET_MS, 6, 6, 20);
    const second = qualityResult(
      first.sampledAtMs + 30_000,
      6,
      3,
      40,
    );

    const history = mergeNetworkQualityHistory(
      mergeNetworkQualityHistory([], first, 1),
      second,
      1,
    );

    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      sampleCount: 2,
      averageLatencyMs: 30,
      probeCount: 12,
      successfulProbeCount: 9,
    });
    expect(networkQualityFailurePercent(history[0]!)).toBe(25);
  });

  it("drops buckets outside the selected retention window", () => {
    const now = 30 * NETWORK_QUALITY_HISTORY_BUCKET_MS;
    const expired = qualityResult(now - 61 * 60_000, 6, 6, 20);
    const current = qualityResult(now, 6, 6, 20);

    const history = mergeNetworkQualityHistory(
      mergeNetworkQualityHistory([], expired, 24, expired.sampledAtMs),
      current,
      1,
      now,
    );

    expect(history.map((point) => point.sampledAtMs)).toEqual([now]);
  });
});

function qualityResult(
  sampledAtMs: number,
  probeCount: number,
  successfulProbeCount: number,
  averageLatencyMs: number,
): NetworkQualityResult {
  return {
    sampledAtMs,
    targetHost: "example.com, one.one.one.one",
    targetPort: 443,
    targetCount: 2,
    successfulTargetCount: 2,
    status: "online",
    dnsAvailable: true,
    dnsLookupMs: 2,
    resolvedAddressCount: 4,
    probeCount,
    successfulProbeCount,
    averageLatencyMs,
    minimumLatencyMs: averageLatencyMs,
    maximumLatencyMs: averageLatencyMs,
    jitterMs: 1,
    tcpProbeFailurePercent:
      (probeCount - successfulProbeCount) / probeCount * 100,
    diagnostics: [],
  };
}
