import { ToolboxInputError } from "../local/toolboxErrors";

/**
 * This browser module only parses and previews a cron expression. The
 * execution-state marker identifies the native scheduler as the source of
 * truth for persistence, DST handling, and dispatch.
 */
export const SCHEDULE_EXECUTION_STATE = "native_scheduler" as const;

export const CRON_SEARCH_HORIZON_YEARS = 5;
export const MAX_CRON_PREVIEW_OCCURRENCES = 10;

/**
 * The one-second preview budget is modelled as a fixed amount of calendar
 * work, rather than reading Date.now(). This keeps a preview deterministic and
 * prevents a slow or changed wall clock from extending a search indefinitely.
 */
export const DEFAULT_CRON_CALENDAR_CANDIDATE_LIMIT = 2_048;

export interface CronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  source: string;
}

export type CronSearchState = "occurrences" | "no_occurrence_in_horizon" | "search_limit";

export interface CronSearchResult {
  state: CronSearchState;
  occurrences: Date[];
  /** The exclusive lower bound supplied by the caller. */
  windowStart: Date;
  /** The inclusive end of the fixed five-year search horizon. */
  windowEnd: Date;
  /** How far this bounded search actually reached. */
  searchedThrough: Date;
  inspectedCalendarCandidates: number;
  maxResults: typeof MAX_CRON_PREVIEW_OCCURRENCES;
  executionState: typeof SCHEDULE_EXECUTION_STATE;
}

export interface CronSearchOptions {
  /**
   * An internal/testing override for the deterministic work budget. It can
   * only reduce the production limit, never make a preview unbounded.
   */
  maxCalendarCandidates?: number;
}

export interface NextOccurrence {
  state: "occurrence" | "no_occurrence_in_horizon" | "search_limit";
  at: Date | null;
  search: CronSearchResult;
}

export function parseCron(source: string): CronSchedule {
  if (new TextEncoder().encode(source).byteLength > 256) {
    throw new ToolboxInputError("cron_too_large", "Cron 规则不能超过 256 字节。");
  }

  const fields = source.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => /[@?]/.test(field))) {
    throw new ToolboxInputError("unsupported_cron", "只支持五段分时日月周 Cron，不支持秒、年份或 Quartz 扩展。");
  }

  const schedule = {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dayOfMonth: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    dayOfWeek: parseField(fields[4], 0, 7, true),
    source,
  };
  assertCalendarCanOccur(schedule);
  return schedule;
}

/**
 * Finds at most ten future wall-clock preview occurrences in a fixed five-year
 * window. The native, IANA-time-zone scheduler remains the source of truth for
 * saved rules, DST, persistence, and execution.
 */
export function findCronOccurrences(schedule: CronSchedule, after: Date, options: CronSearchOptions = {}): CronSearchResult {
  assertValidDate(after);

  const windowStart = new Date(after);
  const windowEnd = new Date(after);
  windowEnd.setFullYear(windowEnd.getFullYear() + CRON_SEARCH_HORIZON_YEARS);
  if (Number.isNaN(windowEnd.getTime())) {
    throw new ToolboxInputError("invalid_search_horizon", "Cron 搜索窗口超出可表示的日期范围。");
  }
  const candidateLimit = resolveCandidateLimit(options.maxCalendarCandidates);
  const occurrences: Date[] = [];
  const dayCursor = new Date(after.getFullYear(), after.getMonth(), after.getDate());
  let inspectedCalendarCandidates = 0;
  let searchedThrough = new Date(dayCursor);

  while (dayCursor <= windowEnd) {
    if (inspectedCalendarCandidates >= candidateLimit) {
      return makeSearchResult("search_limit", occurrences, windowStart, windowEnd, searchedThrough, inspectedCalendarCandidates);
    }

    inspectedCalendarCandidates += 1;
    searchedThrough = new Date(dayCursor);
    if (matchesCalendarDay(schedule, dayCursor)) {
      for (const hour of ascending(schedule.hour)) {
        for (const minute of ascending(schedule.minute)) {
          const occurrence = new Date(dayCursor.getFullYear(), dayCursor.getMonth(), dayCursor.getDate(), hour, minute, 0, 0);
          if (!isExactLocalMinute(occurrence, dayCursor, hour, minute) || occurrence <= after || occurrence > windowEnd) continue;
          occurrences.push(occurrence);
          searchedThrough = new Date(occurrence);
          if (occurrences.length === MAX_CRON_PREVIEW_OCCURRENCES) {
            return makeSearchResult("occurrences", occurrences, windowStart, windowEnd, searchedThrough, inspectedCalendarCandidates);
          }
        }
      }
    }
    dayCursor.setDate(dayCursor.getDate() + 1);
  }

  return makeSearchResult(
    occurrences.length === 0 ? "no_occurrence_in_horizon" : "occurrences",
    occurrences,
    windowStart,
    windowEnd,
    windowEnd,
    inspectedCalendarCandidates,
  );
}

/** Backwards-compatible single-occurrence view over the bounded preview API. */
export function findNextCronOccurrence(schedule: CronSchedule, after: Date): NextOccurrence {
  const search = findCronOccurrences(schedule, after);
  return {
    state: search.state === "occurrences" ? "occurrence" : search.state,
    at: search.occurrences[0] ?? null,
    search,
  };
}

function parseField(source: string, min: number, max: number, sundayAlias = false): Set<number> {
  const values = new Set<number>();
  for (const part of source.split(",")) {
    const match = /^(\*|\d+|\d+-\d+)(?:\/([1-9]\d*))?$/.exec(part);
    if (!match) {
      throw new ToolboxInputError("invalid_cron_field", "Cron 字段范围无效。");
    }

    const rangeSource = match[1];
    const step = match[2] === undefined ? 1 : parseSafeInteger(match[2]);
    if (step === null || step < 1) {
      throw new ToolboxInputError("invalid_cron_step", "Cron 步长必须是正整数。");
    }

    const range = parseRange(rangeSource, min, max);
    if (range === null) {
      throw new ToolboxInputError("invalid_cron_field", "Cron 字段范围无效。");
    }

    for (let value = range.start; value <= range.end; value += step) {
      values.add(sundayAlias && value === 7 ? 0 : value);
    }
  }
  return values;
}

function parseRange(source: string, min: number, max: number): { start: number; end: number } | null {
  if (source === "*") return { start: min, end: max };
  const values = source.split("-").map(parseSafeInteger);
  if (values.some((value) => value === null)) return null;
  const start = values[0]!;
  const end = values.length === 1 ? start : values[1]!;
  if (start < min || start > max || end < min || end > max || end < start) return null;
  return { start, end };
}

function parseSafeInteger(source: string): number | null {
  const value = Number(source);
  return Number.isSafeInteger(value) ? value : null;
}

function assertCalendarCanOccur(schedule: CronSchedule): void {
  // With a restricted weekday, Cron's DOM/DOW OR rule always leaves possible
  // weekdays in each selected month. Only DOM-only rules can be proven empty.
  if (!isFullRange(schedule.dayOfWeek, 0, 6)) return;
  for (const month of schedule.month) {
    for (const dayOfMonth of schedule.dayOfMonth) {
      if (isValidGregorianDate(month, dayOfMonth)) return;
    }
  }
  throw new ToolboxInputError("no_occurrence", "该 Cron 在日历中不可能触发，不能启用。");
}

function isValidGregorianDate(month: number, dayOfMonth: number): boolean {
  if (month === 2 && dayOfMonth === 29) return true;
  return dayOfMonth <= new Date(2025, month, 0).getDate();
}

function matchesCalendarDay(schedule: CronSchedule, day: Date): boolean {
  if (!schedule.month.has(day.getMonth() + 1)) return false;
  const dom = schedule.dayOfMonth.has(day.getDate());
  const dow = schedule.dayOfWeek.has(day.getDay());
  const domWildcard = isFullRange(schedule.dayOfMonth, 1, 31);
  const dowWildcard = isFullRange(schedule.dayOfWeek, 0, 6);
  return (domWildcard || dowWildcard) ? dom && dow : dom || dow;
}

function isFullRange(values: Set<number>, min: number, max: number): boolean {
  for (let value = min; value <= max; value += 1) {
    if (!values.has(value)) return false;
  }
  return true;
}

function isExactLocalMinute(value: Date, calendarDay: Date, hour: number, minute: number): boolean {
  return value.getFullYear() === calendarDay.getFullYear()
    && value.getMonth() === calendarDay.getMonth()
    && value.getDate() === calendarDay.getDate()
    && value.getHours() === hour
    && value.getMinutes() === minute;
}

function ascending(values: Set<number>): number[] {
  return [...values].sort((left, right) => left - right);
}

function resolveCandidateLimit(requestedLimit: number | undefined): number {
  if (requestedLimit === undefined) return DEFAULT_CRON_CALENDAR_CANDIDATE_LIMIT;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new ToolboxInputError("invalid_search_budget", "Cron 搜索预算必须是正整数。");
  }
  return Math.min(requestedLimit, DEFAULT_CRON_CALENDAR_CANDIDATE_LIMIT);
}

function assertValidDate(value: Date): void {
  if (Number.isNaN(value.getTime())) {
    throw new ToolboxInputError("invalid_search_start", "Cron 搜索起点无效。");
  }
}

function makeSearchResult(
  state: CronSearchState,
  occurrences: Date[],
  windowStart: Date,
  windowEnd: Date,
  searchedThrough: Date,
  inspectedCalendarCandidates: number,
): CronSearchResult {
  return {
    state,
    occurrences,
    windowStart,
    windowEnd,
    searchedThrough,
    inspectedCalendarCandidates,
    maxResults: MAX_CRON_PREVIEW_OCCURRENCES,
    executionState: SCHEDULE_EXECUTION_STATE,
  };
}
