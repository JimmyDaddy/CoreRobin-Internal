import { describe, expect, it } from "vitest";

import {
  isActiveView,
  parseOpenDailyRequest,
  PROFESSIONAL_VIEW_EYEBROW,
} from "./appNavigation";

describe("app navigation", () => {
  it("accepts only known application views", () => {
    expect(isActiveView("cleanup")).toBe(true);
    expect(isActiveView("unknown")).toBe(false);
    expect(isActiveView(null)).toBe(false);
  });

  it("normalizes legacy string and structured daily requests", () => {
    expect(parseOpenDailyRequest("history")).toEqual({
      view: "history",
      occurrenceId: null,
    });
    expect(
      parseOpenDailyRequest({ view: "processes", occurrenceId: "incident-1" }),
    ).toEqual({ view: "processes", occurrenceId: "incident-1" });
    expect(parseOpenDailyRequest({ view: "processes", occurrenceId: 42 })).toEqual({
      view: "processes",
      occurrenceId: null,
    });
  });

  it("rejects malformed daily requests and covers every view eyebrow", () => {
    expect(parseOpenDailyRequest({ view: "unknown" })).toBeNull();
    expect(parseOpenDailyRequest({})).toBeNull();
    expect(parseOpenDailyRequest(null)).toBeNull();
    expect(Object.keys(PROFESSIONAL_VIEW_EYEBROW)).toHaveLength(9);
  });
});
