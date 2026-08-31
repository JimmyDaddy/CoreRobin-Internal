import { describe, expect, it } from "vitest";
import { findNextCronOccurrence, parseCron } from "./scheduleTools";

describe("schedule toolbox", () => {
  it("supports the five-field dialect and bounded next occurrence", () => {
    const schedule = parseCron("*/15 9-17 * * 1-5");
    const next = findNextCronOccurrence(schedule, new Date("2026-08-31T08:01:00"));
    expect(next.state).toBe("occurrence");
    expect(next.at?.getHours()).toBe(9);
    expect(next.at?.getMinutes()).toBe(0);
  });

  it("rejects command and Quartz extensions", () => {
    expect(() => parseCron("0 0 * * * rm -rf /")).toThrow();
    expect(() => parseCron("0 0 1 * ?")).toThrow();
  });
});
