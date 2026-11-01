import dayjs from "dayjs";

/** Existing date labels are English regardless of the process-wide Day.js locale. */
export function formatCalendarDate(
  value: Date | number,
  pattern: string,
): string {
  const date = dayjs(value).locale("en");
  if (!date.isValid()) throw new RangeError("Invalid time value");
  return date.format(pattern);
}

/** Parse the persisted calendar-date input in local time, accepting unpadded
 * fields and years 1–9999. Reject rollover dates rather than normalizing them. */
export function parseCalendarDate(value: string): Date {
  const match = /^(\d{1,4})-(\d{1,2})-(\d{1,2})\s*$/.exec(value);
  if (!match) return new Date(NaN);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const result = new Date(0);
  result.setFullYear(year, month - 1, day);
  result.setHours(0, 0, 0, 0);
  return year > 0 &&
    result.getFullYear() === year &&
    result.getMonth() === month - 1 &&
    result.getDate() === day
    ? result
    : new Date(NaN);
}

/** Week boundaries must not change with the global journal locale. */
export function startOfCalendarWeek(value: Date, weekStartsOn: 0 | 1): Date {
  const date = dayjs(value);
  return date
    .subtract((date.day() - weekStartsOn + 7) % 7, "day")
    .startOf("day")
    .toDate();
}
