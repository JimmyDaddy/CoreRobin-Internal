import { describe, expect, it } from "vitest";

import {
  addStartupImpactSample,
  completeStartupImpactMeasurement,
  createStartupImpactAccumulator,
} from "./startupImpact";

describe("startup impact measurement", () => {
  it("settles after three consecutive quiet samples", () => {
    const accumulator = createStartupImpactAccumulator(1_000);
    expect(addStartupImpactSample(accumulator, 6_000, 20, 0, []).settled).toBe(false);
    expect(addStartupImpactSample(accumulator, 11_000, 18, 0, []).settled).toBe(false);
    expect(addStartupImpactSample(accumulator, 16_000, 16, 0, []).settled).toBe(true);
    expect(completeStartupImpactMeasurement(accumulator, 16_000, true).settledAfterMs).toBe(15_000);
  });
});
