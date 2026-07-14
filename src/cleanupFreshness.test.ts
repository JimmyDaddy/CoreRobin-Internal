import { describe, expect, it } from "vitest";

import { cleanupPathChanged } from "./cleanupFreshness";

describe("cleanupPathChanged", () => {
  it("marks a missing path as changed", () => {
    expect(cleanupPathChanged({ path: "~/Downloads", exists: false, modifiedAtMs: null }, 1_000)).toBe(true);
  });

  it("marks a path modified after the scan as changed", () => {
    expect(cleanupPathChanged({ path: "~/Downloads", exists: true, modifiedAtMs: 1_001 }, 1_000)).toBe(true);
  });

  it("keeps an unchanged or unverifiable path current", () => {
    expect(cleanupPathChanged({ path: "~/Downloads", exists: true, modifiedAtMs: 999 }, 1_000)).toBe(false);
    expect(cleanupPathChanged({ path: "~/Downloads", exists: true, modifiedAtMs: null }, 1_000)).toBe(false);
  });
});
