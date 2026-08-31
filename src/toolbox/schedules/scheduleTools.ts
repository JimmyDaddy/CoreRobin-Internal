import { ToolboxInputError } from "../local/toolboxErrors";

export interface CronSchedule {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  source: string;
}

export interface NextOccurrence {
  state: "occurrence" | "no_occurrence" | "budget_exhausted";
  at: Date | null;
}

export function parseCron(source: string): CronSchedule {
  if (new TextEncoder().encode(source).byteLength > 256) throw new ToolboxInputError("cron_too_large", "Cron 规则不能超过 256 字节。 ");
  const fields = source.trim().split(/\s+/);
  if (fields.length !== 5 || fields.some((field) => /[@?]/.test(field))) throw new ToolboxInputError("unsupported_cron", "只支持五段分时日月周 Cron，不支持秒、年份或 Quartz 扩展。 ");
  return { minute: parseField(fields[0], 0, 59), hour: parseField(fields[1], 0, 23), dayOfMonth: parseField(fields[2], 1, 31), month: parseField(fields[3], 1, 12), dayOfWeek: parseField(fields[4], 0, 7, true), source };
}

export function findNextCronOccurrence(schedule: CronSchedule, after: Date, maxYears = 5): NextOccurrence {
  const end = new Date(after.getTime());
  end.setFullYear(end.getFullYear() + maxYears);
  const cursor = new Date(after.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  let inspected = 0;
  while (cursor <= end && inspected < 2_628_000) {
    inspected += 1;
    if (schedule.minute.has(cursor.getMinutes()) && schedule.hour.has(cursor.getHours()) && schedule.month.has(cursor.getMonth() + 1)) {
      const dom = schedule.dayOfMonth.has(cursor.getDate());
      const dow = schedule.dayOfWeek.has(cursor.getDay());
      const domWildcard = schedule.dayOfMonth.size === 31;
      const dowWildcard = schedule.dayOfWeek.size === 7;
      if ((domWildcard || dowWildcard) ? (dom && dow) : (dom || dow)) return { state: "occurrence", at: new Date(cursor) };
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return { state: inspected >= 2_628_000 ? "budget_exhausted" : "no_occurrence", at: null };
}

function parseField(source: string, min: number, max: number, sundayAlias = false): Set<number> {
  const values = new Set<number>();
  for (const part of source.split(",")) {
    const [rangeSource, stepSource] = part.split("/");
    const step = stepSource === undefined ? 1 : Number.parseInt(stepSource, 10);
    if (!Number.isInteger(step) || step < 1) throw new ToolboxInputError("invalid_cron_step", "Cron 步长必须是正整数。 ");
    const [start, end] = rangeSource === "*" ? [min, max] : rangeSource.split("-").map((value) => Number.parseInt(value, 10));
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || start > max || end < min || end > max || end < start) throw new ToolboxInputError("invalid_cron_field", "Cron 字段范围无效。 ");
    for (let value = start; value <= end; value += step) values.add(sundayAlias && value === 7 ? 0 : value);
  }
  return values;
}
