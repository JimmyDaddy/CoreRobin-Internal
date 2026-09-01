import { describe, expect, it, vi } from "vitest";
import { ToolboxInputError } from "../local/toolboxErrors";
import {
  CRON_SEARCH_HORIZON_YEARS,
  DEFAULT_CRON_CALENDAR_CANDIDATE_LIMIT,
  MAX_CRON_PREVIEW_OCCURRENCES,
  SCHEDULE_EXECUTION_STATE,
  findCronOccurrences,
  findNextCronOccurrence,
  parseCron,
  type CronSchedule,
} from "./scheduleTools";

describe("schedule toolbox", () => {
  it("supports the five-field dialect and a bounded next occurrence", () => {
    const schedule = parseCron("*/15 9-17 * * 1-5");
    const next = findNextCronOccurrence(schedule, new Date("2026-08-31T08:01:00"));

    expect(next.state).toBe("occurrence");
    expect(next.at?.getHours()).toBe(9);
    expect(next.at?.getMinutes()).toBe(0);
    expect(next.search.executionState).toBe(SCHEDULE_EXECUTION_STATE);
  });

  it("rejects commands, unsupported dialects, and malformed numeric fields", () => {
    expect(() => parseCron("0 0 * * * rm -rf /")).toThrow(ToolboxInputError);
    expect(() => parseCron("0 0 1 * ?")).toThrow(ToolboxInputError);
    expect(() => parseCron("0 0 * * * # reminder")).toThrow(ToolboxInputError);
    expect(() => parseCron("*/2/3 0 * * *")).toThrow(ToolboxInputError);
    expect(() => parseCron("1x 0 * * *")).toThrow(ToolboxInputError);
  });

  it("statically rejects calendar dates that can never occur", () => {
    expect(() => parseCron("0 0 31 2 *")).toThrow(expect.objectContaining({ code: "no_occurrence" }));
    expect(() => parseCron("0 0 31 4,6,9,11 *")).toThrow(expect.objectContaining({ code: "no_occurrence" }));
    expect(() => parseCron("0 0 29 2 *")).not.toThrow();
    expect(() => parseCron("0 0 31 2 1")).not.toThrow(); // DOM/DOW uses Cron OR semantics.
  });

  it("uses the fixed five-year window and returns partial results with its range", () => {
    const after = new Date("2026-01-02T00:00:00");
    const result = findCronOccurrences(parseCron("0 0 1 1 *"), after);

    expect(result.state).toBe("occurrences");
    expect(result.occurrences).toHaveLength(5);
    expect(result.occurrences.every((date) => date > after && date <= result.windowEnd)).toBe(true);
    expect(result.windowEnd.getFullYear()).toBe(after.getFullYear() + CRON_SEARCH_HORIZON_YEARS);
    expect(result.searchedThrough.getTime()).toBe(result.windowEnd.getTime());
    expect(result.maxResults).toBe(MAX_CRON_PREVIEW_OCCURRENCES);
  });

  it("returns no_occurrence_in_horizon instead of asserting a permanent failure", () => {
    const validButEmptySchedule: CronSchedule = {
      ...parseCron("0 0 * * *"),
      minute: new Set(),
    };
    const result = findCronOccurrences(validButEmptySchedule, new Date("2026-01-01T00:00:00"));

    expect(result.state).toBe("no_occurrence_in_horizon");
    expect(result.occurrences).toEqual([]);
    expect(result.searchedThrough.getTime()).toBe(result.windowEnd.getTime());
  });

  it("caps previews at ten occurrences", () => {
    const result = findCronOccurrences(parseCron("* * * * *"), new Date("2026-01-01T00:00:00"));
    const first = result.occurrences[0];
    const last = result.occurrences[MAX_CRON_PREVIEW_OCCURRENCES - 1];

    expect(result.state).toBe("occurrences");
    expect(result.occurrences).toHaveLength(MAX_CRON_PREVIEW_OCCURRENCES);
    expect(first?.getHours()).toBe(0);
    expect(first?.getMinutes()).toBe(1);
    expect(last?.getHours()).toBe(0);
    expect(last?.getMinutes()).toBe(10);
  });

  it("uses deterministic candidate work limits instead of the wall clock", () => {
    const schedule = parseCron("0 0 1 1 *");
    const after = new Date("2026-01-02T00:00:00");
    const limited = findCronOccurrences(schedule, after, { maxCalendarCandidates: 1 });

    expect(limited.state).toBe("search_limit");
    expect(limited.occurrences).toEqual([]);
    expect(limited.inspectedCalendarCandidates).toBe(1);
    expect(DEFAULT_CRON_CALENDAR_CANDIDATE_LIMIT).toBeGreaterThan(1);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2000-01-01T00:00:00"));
      const first = findCronOccurrences(parseCron("0 12 * * *"), after);
      vi.setSystemTime(new Date("2040-01-01T00:00:00"));
      const second = findCronOccurrences(parseCron("0 12 * * *"), after);

      expect(second.state).toBe(first.state);
      expect(second.occurrences.map((date) => date.getTime())).toEqual(first.occurrences.map((date) => date.getTime()));
      expect(second.inspectedCalendarCandidates).toBe(first.inspectedCalendarCandidates);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects search inputs whose five-year horizon cannot be represented", () => {
    const latestJavaScriptDate = new Date(8_640_000_000_000_000);

    expect(() => findCronOccurrences(parseCron("0 0 * * *"), latestJavaScriptDate)).toThrow(
      expect.objectContaining({ code: "invalid_search_horizon" }),
    );
  });
});
