// SPDX-License-Identifier: AGPL-3.0-or-later

import dayjs from "dayjs";
import advancedFormat from "dayjs/plugin/advancedFormat.js";
import customParseFormat from "dayjs/plugin/customParseFormat.js";
import isoWeek from "dayjs/plugin/isoWeek.js";
import utc from "dayjs/plugin/utc.js";

// Match the public Dayjs plugins used by the pinned Mermaid Gantt runtime.
// UTC keeps source dates independent of the browser's locale and time zone.
dayjs.extend(customParseFormat);
dayjs.extend(advancedFormat);
dayjs.extend(isoWeek);
dayjs.extend(utc);

// UTC forwards the public Dayjs locale/strict overload unchanged. Its plugin
// declarations omit that locale overload; retain it without changing globals.
const parseUtcDate = dayjs.utc as typeof dayjs;

import type {
  GanttCalendarModel,
  GanttDiagnostic,
  MermaidGanttTask,
} from "./types.js";

export const GANTT_DAY_MS = 86_400_000;

/** Converts the effective exclusive end back to an explicit source boundary. */
export function ganttSourceEndMs(
  effectiveEnd: number,
  inclusiveEndDates: boolean | null,
  _task: Pick<MermaidGanttTask, "isMilestone" | "isVert">,
) {
  // Native inclusive end parsing precedes shape rendering, including points.
  return effectiveEnd - (inclusiveEndDates ? GANTT_DAY_MS : 0);
}

/** Duration units accepted by the bundled Mermaid 11.17.2 Gantt runtime. */
export const GANTT_DURATION_UNITS = [
  "ms",
  "s",
  "m",
  "h",
  "d",
  "w",
  "M",
  "y",
] as const;
export type GanttDurationUnit = (typeof GANTT_DURATION_UNITS)[number];

type GanttElapsedDurationUnit = Exclude<GanttDurationUnit, "M" | "y">;
const UNIT_MS: Record<GanttElapsedDurationUnit, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: GANTT_DAY_MS,
  w: 7 * GANTT_DAY_MS,
};

export type GanttDateFormatSupport = {
  readonly supported: boolean;
  readonly hasTime: boolean;
};

/** Format parsing belongs to Dayjs; literals do not enable time controls. */
export function inspectGanttDateFormat(format: string): GanttDateFormatSupport {
  const tokens = format.replace(/\[[^\]]*\]/g, "");
  return {
    supported: Boolean(format.trim()),
    hasTime: /[HhmsSAaxX]/.test(tokens),
  };
}

export function ganttDateFormatOrDefault(format: string) {
  return format.trim() || "YYYY-MM-DD";
}

function zoneFormat(format: string, lexeme: string) {
  return format.replace(/\[[^\]]*\]|ZZ?/g, (token) =>
    token.startsWith("[") ? token : `[${lexeme}]`,
  );
}

/** Recover the authored fixed offset without interpreting escaped literals. */
function authoredZone(value: string, format: string, instant: number) {
  if (!/Z/.test(format.replace(/\[[^\]]*\]/g, ""))) return null;
  for (const match of value.matchAll(/Z|[+-]\d{2}:?\d{2}/g)) {
    const lexeme = match[0];
    const digits = lexeme.replace(/[^\d]/g, "");
    const hours = Number(digits.slice(0, 2));
    const minutes = Number(digits.slice(2));
    if (hours > 23 || minutes > 59) continue;
    const offset =
      lexeme === "Z"
        ? 0
        : (lexeme[0] === "-" ? -1 : 1) * (hours * 60 + minutes);
    const candidate = dayjs.utc(instant).utcOffset(offset).locale("en");
    if (candidate.format(zoneFormat(format, lexeme)) === value)
      return { offset, lexeme };
  }
  return null;
}

/** Formats in UTC, retaining an authored offset when changing a boundary. */
export function formatGanttDateValue(
  valueMs: number,
  format: string,
  original?: string,
  boundary: "start" | "end" = "start",
) {
  const effective = ganttDateFormatOrDefault(format);
  if (
    effective === "x" ||
    (effective === "X" && boundary === "start" && valueMs >= 0)
  )
    return String(valueMs);
  const originalMs = original
    ? parseGanttDateValue(original, effective, boundary)
    : null;
  const zone =
    original && originalMs !== null
      ? authoredZone(original, effective, originalMs)
      : null;
  const date = dayjs.utc(valueMs).locale("en");
  return zone
    ? date.utcOffset(zone.offset).format(zoneFormat(effective, zone.lexeme))
    : date.format(effective);
}

/** Strict Dayjs decoding, with explicit offsets validated in their wall clock. */
export function parseGanttDateValue(
  value: string,
  format: string,
  boundary: "start" | "end" = "start",
): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const effective = ganttDateFormatOrDefault(format);
  // The pinned start decoder treats positive x/X lexemes as milliseconds.
  // End/calendar decoding uses public Dayjs semantics: X is epoch seconds.
  if (
    boundary === "start" &&
    (effective === "x" || effective === "X") &&
    /^\d+$/.test(trimmed)
  ) {
    const ms = Number(trimmed);
    return Number.isSafeInteger(ms) && !Number.isNaN(new Date(ms).getTime())
      ? ms
      : null;
  }
  if (/Z/.test(effective.replace(/\[[^\]]*\]/g, ""))) {
    const candidate = parseUtcDate(trimmed, effective, "en");
    if (!candidate.isValid()) return null;
    return authoredZone(trimmed, effective, candidate.valueOf())
      ? candidate.valueOf()
      : null;
  }
  const parsed = parseUtcDate(trimmed, effective, "en", true);
  return parsed.isValid() ? parsed.valueOf() : null;
}

/** Resolve runtime duration units at their actual start. Days/weeks use
 * Dayjs rounding; months/years are calendar additions with end-of-month clamp,
 * not fixed 30/365-day spans. Source lexemes remain unchanged. */
export function parseGanttDurationMs(
  value: string,
  startMs: number,
): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|M|y)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const unit = match[2] as GanttDurationUnit;
  if (unit === "M" || unit === "y") {
    const end = new Date(startMs);
    const day = end.getUTCDate();
    end.setUTCDate(1);
    if (unit === "M") end.setUTCMonth(end.getUTCMonth() + Math.trunc(amount));
    else end.setUTCFullYear(end.getUTCFullYear() + Math.trunc(amount));
    const lastDay = new Date(
      Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0),
    ).getUTCDate();
    end.setUTCDate(Math.min(day, lastDay));
    const duration = end.getTime() - startMs;
    return Number.isFinite(duration) ? duration : null;
  }
  const duration =
    unit === "d" || unit === "w"
      ? Math.round(amount * (unit === "w" ? 7 : 1)) * GANTT_DAY_MS
      : amount * UNIT_MS[unit];
  const rounded = Math.trunc(duration);
  // A finite amount can still exceed Date's representable range. Reject it
  // before calendar iteration or date formatting can hang/crash the consumer.
  return Number.isFinite(duration) &&
    !Number.isNaN(new Date(startMs + rounded).getTime())
    ? rounded
    : null;
}

const DURATION_UNITS_LARGE_FIRST: readonly GanttElapsedDurationUnit[] = [
  "w",
  "d",
  "h",
  "m",
  "s",
  "ms",
];

/**
 * Renders a millisecond span back into the duration notation the Gantt runtime
 * accepts. The largest unit that divides the span exactly wins, so a one-hour
 * span never degrades into a rounded fractional day. Calendar months/years
 * cannot encode an elapsed span independently of the start, so generated
 * durations use only elapsed units; untouched authored units are preserved.
 */
export function formatGanttDurationMs(valueMs: number): string | null {
  if (!Number.isFinite(valueMs) || valueMs < 0) return null;
  for (const unit of DURATION_UNITS_LARGE_FIRST) {
    const value = valueMs / UNIT_MS[unit];
    if (Number.isInteger(value)) return `${value}${unit}`;
  }
  for (const unit of DURATION_UNITS_LARGE_FIRST) {
    if (unit === "d" || unit === "w") continue;
    const value = Math.round((valueMs / UNIT_MS[unit]) * 1e6) / 1e6;
    if (value > 0 && Math.abs(value * UNIT_MS[unit] - valueMs) < 0.5) {
      return `${value}${unit}`;
    }
  }
  return `${valueMs}ms`;
}

const WEEKDAY_INDEX: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 0,
};

export type GanttCalendarResolution = {
  readonly excludedWeekdays: ReadonlySet<number>;
  readonly excludedDates: ReadonlySet<number>;
  readonly includedDates: ReadonlySet<number>;
  readonly excludedInstants: ReadonlySet<number>;
  readonly includedInstants: ReadonlySet<number>;
  readonly diagnostics: readonly GanttDiagnostic[];
};

/**
 * Resolves the runtime's working calendar. `weekday` affects weekly ticks;
 * `weekend` chooses the excluded pair. Includes accepts dates, not weekday
 * aliases. ISO date-only entries match a whole day even under a time format;
 * formatted timestamps match the exact checked instant.
 */
export function resolveGanttCalendar(
  calendar: GanttCalendarModel,
  statementRange: (
    name: string,
  ) =>
    { line: number; start: number; end: number; endLine: number } | undefined,
): GanttCalendarResolution {
  const excluded = new Set<number>();
  const excludedDates = new Set<number>();
  const includedDates = new Set<number>();
  const excludedInstants = new Set<number>();
  const includedInstants = new Set<number>();
  const diagnostics: GanttDiagnostic[] = [];
  for (const name of ["weekday", "weekend"] as const) {
    const value = calendar[name]?.trim().toLowerCase();
    if (
      value &&
      (name === "weekday"
        ? !(value in WEEKDAY_INDEX)
        : value !== "friday" && value !== "saturday")
    ) {
      diagnostics.push({
        code: "unsupported-option",
        message: `Unknown ${name} value "${value}".`,
        range: statementRange(name) ?? {
          end: 0,
          endLine: 1,
          line: 1,
          start: 0,
        },
      });
    }
  }
  // `weekday` chooses weekly axis ticks, not a non-working day. `weekend`
  // chooses the pair consumed only when an excludes list contains weekends.
  const weekendStart =
    calendar.weekend?.trim().toLowerCase() === "friday" ? 5 : 6;
  const applyList = (
    raw: readonly string[],
    dates: Set<number>,
    instants: Set<number>,
    code: "excludes" | "includes",
  ) => {
    // Native mergeTokens splits whitespace as well as commas. A dateFormat
    // containing spaces cannot make a calendar entry with spaces atomic.
    for (const entry of raw.flatMap((value) =>
      value.toLowerCase().split(/[\s,]+/),
    )) {
      const value = entry.trim().toLowerCase();
      if (!value) continue;
      if (value === "weekends") {
        if (code === "excludes") {
          excluded.add(weekendStart);
          excluded.add((weekendStart + 1) % 7);
        }
        continue;
      }
      if (value in WEEKDAY_INDEX) {
        if (code === "excludes") excluded.add(WEEKDAY_INDEX[value]);
        continue;
      }
      const iso = /^\d{4}-\d{2}-\d{2}$/.test(entry.trim());
      const ms = parseGanttDateValue(
        entry,
        iso ? "YYYY-MM-DD" : calendar.dateFormat,
        "end",
      );
      if (ms === null) {
        const range = statementRange(code);
        diagnostics.push({
          code: "invalid-date",
          message: `Unreadable ${code} entry "${entry}".`,
          range: range ?? { end: 0, endLine: 1, line: 1, start: 0 },
        });
        continue;
      }
      const timed =
        !iso &&
        (inspectGanttDateFormat(calendar.dateFormat).hasTime ||
          /^[xX]$/.test(calendar.dateFormat.trim()));
      if (timed) instants.add(ms);
      else dates.add(startOfUtcDay(ms));
    }
  };
  applyList(calendar.excludes, excludedDates, excludedInstants, "excludes");
  applyList(calendar.includes, includedDates, includedInstants, "includes");
  return {
    diagnostics,
    excludedDates,
    excludedWeekdays: excluded,
    includedDates,
    excludedInstants,
    includedInstants,
  };
}

export function startOfUtcDay(ms: number) {
  return Math.floor(ms / GANTT_DAY_MS) * GANTT_DAY_MS;
}

export function isGanttDayExcluded(
  dayMs: number,
  calendar: GanttCalendarResolution,
) {
  const day = startOfUtcDay(dayMs);
  if (calendar.includedDates.has(day) || calendar.includedInstants.has(dayMs))
    return false;
  const weekday = new Date(day).getUTCDay();
  if (calendar.excludedDates.has(day) || calendar.excludedInstants.has(dayMs))
    return true;
  return calendar.excludedWeekdays.has(weekday);
}

/**
 * Advances a start by a duration while skipping excluded days, mirroring the
 * runtime's working-calendar behaviour without rounding fractional spans.
 */
export function addGanttDuration(
  startMs: number,
  durationMs: number,
  calendar: GanttCalendarResolution,
) {
  if (durationMs <= 0) return startMs;
  const hasExclusions =
    calendar.excludedWeekdays.size > 0 ||
    calendar.excludedDates.size > 0 ||
    calendar.excludedInstants.size > 0;
  if (!hasExclusions) {
    return startMs + durationMs;
  }
  let end = startMs + durationMs;
  const limit = end + 10_000 * GANTT_DAY_MS;
  // Mermaid checks successive instants one day after the start, including
  // the end day. Friday + 1d therefore skips Saturday and Sunday and ends
  // Monday; counting the start day instead produces a different after-chain.
  for (
    let cursor = startMs + GANTT_DAY_MS;
    cursor <= end;
    cursor += GANTT_DAY_MS
  ) {
    if (isGanttDayExcluded(cursor, calendar)) {
      end += GANTT_DAY_MS;
      if (end > limit || Number.isNaN(new Date(end).getTime())) return null;
    }
  }
  return end;
}

/**
 * Inverse of `addGanttDuration`: the working length in milliseconds that
 * `addGanttDuration(startMs, ...)` would need to reach `endMs` under the same
 * calendar. An excluded end instant may have no preimage; callers must refuse
 * that resize instead of committing a duration that reparses to another end.
 */
export function ganttWorkingDurationMs(
  startMs: number,
  endMs: number,
  calendar: GanttCalendarResolution,
) {
  if (endMs <= startMs) return 0;
  const hasExclusions =
    calendar.excludedWeekdays.size > 0 ||
    calendar.excludedDates.size > 0 ||
    calendar.excludedInstants.size > 0;
  const span = endMs - startMs;
  if (!hasExclusions) return span;
  let raw = span;
  for (let day = startMs + GANTT_DAY_MS; day <= endMs; day += GANTT_DAY_MS) {
    if (isGanttDayExcluded(day, calendar)) raw -= GANTT_DAY_MS;
  }
  return raw >= 0 && addGanttDuration(startMs, raw, calendar) === endMs
    ? raw
    : null;
}

export type GanttResolvedInterval = {
  readonly start: number;
  readonly end: number;
  readonly startKind: MermaidGanttTask["scheduleKind"];
  readonly durationMs: number | null;
};

/**
 * Resolves every task interval from source forms only. `after` resolves to the
 * latest dependency end, `until` to the earliest referenced start, implicit
 * previous to the preceding task end. Cycles and missing references produce
 * local diagnostics instead of a fabricated fallback date.
 */
export function resolveGanttTaskIntervals(input: {
  readonly tasks: readonly MermaidGanttTask[];
  readonly calendar: GanttCalendarResolution;
  readonly dateFormat: string;
  readonly inclusiveEndDates: boolean;
}): {
  /** Intervals are keyed by edit-session record, not potentially duplicate IDs. */
  intervals: ReadonlyMap<string, GanttResolvedInterval>;
  diagnostics: readonly GanttDiagnostic[];
} {
  const { calendar, dateFormat, inclusiveEndDates, tasks } = input;
  const intervals = new Map<string, GanttResolvedInterval>();
  const diagnostics: GanttDiagnostic[] = [];
  const byId = new Map<string, MermaidGanttTask>();
  const duplicatedIds = new Set<string>();
  for (const task of tasks) {
    if (byId.has(task.id) || duplicatedIds.has(task.id)) {
      byId.delete(task.id);
      duplicatedIds.add(task.id);
    } else byId.set(task.id, task);
  }
  const resolving = new Set<string>();
  const zeroRange = { end: 0, endLine: 1, line: 1, start: 0 };

  const resolve = (task: MermaidGanttTask): GanttResolvedInterval | null => {
    const cached = intervals.get(task.recordId);
    if (cached) return cached;
    if (resolving.has(task.recordId)) {
      diagnostics.push({
        code: "cycle",
        message: `Dependency cycle at task "${task.label || task.id}".`,
        range: zeroRange,
        statementId: task.recordId,
      });
      return null;
    }
    resolving.add(task.recordId);
    let start: number | null = null;
    let startKind: MermaidGanttTask["scheduleKind"] = "none";
    if (task.scheduleKind === "after") {
      const deps = task.afterIds.map((id) => {
        const dep = byId.get(id);
        if (!dep) {
          diagnostics.push({
            code: duplicatedIds.has(id)
              ? "duplicate-id"
              : "unresolved-reference",
            detail: id,
            field: "reference",
            message: duplicatedIds.has(id)
              ? `Ambiguous task id "${id}" in after-reference.`
              : `Unknown task id "${id}" in after-reference.`,
            range: zeroRange,
            statementId: task.recordId,
          });
          return null;
        }
        return resolve(dep);
      });
      if (deps.some((dep) => dep === null)) {
        resolving.delete(task.recordId);
        return null;
      }
      const resolved = deps as GanttResolvedInterval[];
      if (!resolved.length) {
        resolving.delete(task.recordId);
        return null;
      }
      start = Math.max(...resolved.map((dep) => dep.end));
      startKind = "after";
    } else if (task.scheduleKind === "previous") {
      const previous = tasks[task.order - 1];
      const resolvedPrevious = previous ? resolve(previous) : null;
      if (!previous || !resolvedPrevious) {
        resolving.delete(task.recordId);
        return null;
      }
      start = resolvedPrevious.end;
      startKind = "previous";
    } else if (task.scheduleKind === "explicit") {
      start = parseGanttDateValue(task.start, dateFormat);
      if (start === null) {
        diagnostics.push({
          code: "invalid-date",
          detail: task.start,
          field: "schedule",
          message: `Unreadable start value "${task.start}".`,
          range: zeroRange,
          statementId: task.recordId,
        });
        resolving.delete(task.recordId);
        return null;
      }
      startKind = "explicit";
    } else if (task.scheduleKind === "until") {
      start = parseGanttDateValue(task.start, dateFormat);
      if (start === null) {
        resolving.delete(task.recordId);
        return null;
      }
      startKind = "until";
    }
    if (start === null) {
      resolving.delete(task.recordId);
      return null;
    }

    let end: number | null = null;
    let durationMs: number | null = null;
    // `until` fixes the end independently of how the start was resolved, so
    // `after a, until b` keeps both source forms.
    if (task.untilIds.length) {
      const refs = task.untilIds.map((id) => {
        const dep = byId.get(id);
        if (!dep) {
          diagnostics.push({
            code: duplicatedIds.has(id)
              ? "duplicate-id"
              : "unresolved-reference",
            detail: id,
            field: "reference",
            message: duplicatedIds.has(id)
              ? `Ambiguous task id "${id}" in until-reference.`
              : `Unknown task id "${id}" in until-reference.`,
            range: zeroRange,
            statementId: task.recordId,
          });
          return null;
        }
        return resolve(dep);
      });
      if (refs.some((ref) => ref === null)) {
        resolving.delete(task.recordId);
        return null;
      }
      const resolved = refs as GanttResolvedInterval[];
      if (!resolved.length) {
        resolving.delete(task.recordId);
        return null;
      }
      end = Math.min(...resolved.map((ref) => ref.start));
    } else if (task.end) {
      end = parseGanttDateValue(task.end, dateFormat, "end");
      if (end === null) {
        diagnostics.push({
          code: "invalid-date",
          detail: task.end,
          message: `Unreadable end value "${task.end}".`,
          range: zeroRange,
          statementId: task.recordId,
          field: "schedule",
        });
        resolving.delete(task.recordId);
        return null;
      }
      if (inclusiveEndDates) end += GANTT_DAY_MS;
    } else if (task.duration) {
      durationMs = parseGanttDurationMs(task.duration, start);
      if (durationMs === null) {
        diagnostics.push({
          code: "invalid-duration",
          detail: task.duration,
          message: `Unreadable duration "${task.duration}".`,
          range: zeroRange,
          statementId: task.recordId,
          field: "schedule",
        });
        resolving.delete(task.recordId);
        return null;
      }
      end = addGanttDuration(start, durationMs, calendar);
    } else {
      end = start;
    }
    if (end === null || end < start) {
      diagnostics.push({
        code: "invalid-schedule",
        message: `Task "${task.label || task.id}" ends before it starts.`,
        range: zeroRange,
        statementId: task.recordId,
        field: "schedule",
      });
      resolving.delete(task.recordId);
      return null;
    }
    const interval: GanttResolvedInterval = {
      durationMs,
      end,
      start,
      startKind,
    };
    intervals.set(task.recordId, interval);
    resolving.delete(task.recordId);
    return interval;
  };

  for (const task of tasks) resolve(task);
  return { diagnostics, intervals };
}

/**
 * Consecutive excluded days inside a visible range, used by the view to show
 * calendar exclusions quietly on the axis. Pure schedule semantics stay here.
 */
export function ganttExcludedBands(
  range: { start: number; end: number },
  calendar: GanttCalendarResolution,
): readonly { start: number; end: number }[] {
  if (
    calendar.excludedDates.size === 0 &&
    calendar.excludedWeekdays.size === 0
  ) {
    return [];
  }
  const bands: { start: number; end: number }[] = [];
  // An exact timestamp exclusion is not a whole excluded day. Day bands share
  // date/weekday precedence, but must neither broaden instants nor exceed the
  // visible range's partial first/last day.
  const dayCalendar = {
    ...calendar,
    excludedInstants: new Set<number>(),
    includedInstants: new Set<number>(),
  };
  let current: { start: number; end: number } | null = null;
  for (
    let day = startOfUtcDay(range.start);
    day < range.end;
    day += GANTT_DAY_MS
  ) {
    if (isGanttDayExcluded(day, dayCalendar)) {
      if (current) current.end = Math.min(range.end, day + GANTT_DAY_MS);
      else
        current = {
          end: Math.min(range.end, day + GANTT_DAY_MS),
          start: Math.max(range.start, day),
        };
      continue;
    }
    if (current) {
      bands.push(current);
      current = null;
    }
  }
  if (current) bands.push(current);
  return bands;
}
