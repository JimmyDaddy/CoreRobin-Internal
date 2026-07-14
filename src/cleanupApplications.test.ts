import { describe, expect, it } from "vitest";

import { findUnusedApplications, unusedApplicationDays } from "./cleanupApplications";
import type { CleanupApplication } from "./types";

const DAY = 86_400_000;

function application(name: string, lastUsedAtMs: number | null, sizeBytes = 1): CleanupApplication {
  return { name, path: `/Applications/${name}.app`, sizeBytes, lastUsedAtMs, modifiedAtMs: null };
}

describe("unused application inventory", () => {
  it("only classifies applications with a confirmed last-use date older than six months", () => {
    const now = 250 * DAY;
    expect(findUnusedApplications([
      application("Unknown", null),
      application("Recent", now - 20 * DAY),
      application("Old", now - 200 * DAY),
    ], now).map((item) => item.name)).toEqual(["Old"]);
  });

  it("orders the oldest confirmed applications first and reports whole inactive days", () => {
    const now = 400 * DAY;
    const results = findUnusedApplications([
      application("Newer", now - 190 * DAY, 10),
      application("Older", now - 300 * DAY, 5),
    ], now);

    expect(results.map((item) => item.name)).toEqual(["Older", "Newer"]);
    expect(unusedApplicationDays(results[0], now)).toBe(300);
  });
});
