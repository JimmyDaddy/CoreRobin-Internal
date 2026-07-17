// @vitest-environment jsdom

import { describe, expect, it } from "vitest";

import { readiness } from "./useSensorReadiness";

describe("sensor readiness", () => {
  it("distinguishes first sampling, unsupported hardware, and a failed refresh", () => {
    expect(readiness(false, true, null, null).status).toBe("waiting");
    expect(readiness(false, false, null, false).status).toBe("unsupported");
    expect(readiness(false, false, 1_000, true)).toEqual({
      status: "unavailable",
      lastSuccessfulAtMs: 1_000,
    });
    expect(readiness(true, false, 2_000, true).status).toBe("available");
  });
});
