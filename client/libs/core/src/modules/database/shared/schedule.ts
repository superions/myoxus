// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DatabaseCalendarDateMode,
  DatabaseFieldKind,
  type DatabaseScheduleWindowInput,
  DatabaseTimelineZoom,
  DatabaseViewKind,
} from "@myoxus/graphql";
import {
  type DatabaseScheduleEvent,
  getLocaleWeekStart,
} from "@myoxus/ui-facade";

import { databaseTemporalAxis } from "./temporal";
import { getCellValue } from "../model";
import type { DatabaseField, DatabaseRowRecord, DatabaseView } from "../types";

export type DatabaseScheduleViewLevel =
  "day" | "week" | "month" | "quarter" | "year";

function zonedParts(value: string | Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  }).formatToParts(typeof value === "string" ? new Date(value) : value);
  return (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
}

export function databaseZonedDateTime(value: string, timeZone: string) {
  const part = zonedParts(value, timeZone);
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

export function databaseZonedDate(value: string, timeZone: string) {
  const part = zonedParts(value, timeZone);
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function databaseTimeZoneOffsetMilliseconds(
  instant: Date,
  timeZone: string,
) {
  const part = zonedParts(instant, timeZone);
  const projected = Date.UTC(
    Number(part("year")),
    Number(part("month")) - 1,
    Number(part("day")),
    Number(part("hour")),
    Number(part("minute")),
    Number(part("second")),
  );
  return projected - instant.getTime();
}

/** Converts a Mantine wall-clock value in one IANA zone to a UTC instant. */
export function databaseWallTimeToInstant(value: string, timeZone: string) {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2})(?::(\d{2}))?(?::(\d{2}))?)?/,
  );
  if (!match) return null;
  const projected = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? 0),
    Number(match[5] ?? 0),
    Number(match[6] ?? 0),
  );
  let instant = new Date(projected);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = new Date(
      projected - databaseTimeZoneOffsetMilliseconds(instant, timeZone),
    );
    if (next.getTime() === instant.getTime()) break;
    instant = next;
  }
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

function calendarLevel(mode: DatabaseCalendarDateMode | null | undefined) {
  switch (mode) {
    case DatabaseCalendarDateMode.Day:
      return "day" as const;
    case DatabaseCalendarDateMode.Week:
      return "week" as const;
    case DatabaseCalendarDateMode.Year:
      return "year" as const;
    case DatabaseCalendarDateMode.Month:
    default:
      return "month" as const;
  }
}

function timelineLevel(zoom: DatabaseTimelineZoom | null | undefined) {
  switch (zoom) {
    case DatabaseTimelineZoom.Day:
      return "day" as const;
    case DatabaseTimelineZoom.Week:
      return "week" as const;
    case DatabaseTimelineZoom.Year:
      return "year" as const;
    case DatabaseTimelineZoom.Quarter:
      return "quarter" as const;
    case DatabaseTimelineZoom.Month:
    default:
      return "month" as const;
  }
}

export function databaseScheduleViewLevel(
  view: DatabaseView,
): DatabaseScheduleViewLevel | null {
  if (view.viewKind === DatabaseViewKind.Calendar) {
    return calendarLevel(view.config.calendar?.dateMode);
  }
  if (view.viewKind === DatabaseViewKind.Timeline) {
    return timelineLevel(view.config.timeline?.zoom);
  }
  if (view.viewKind === DatabaseViewKind.Gantt) {
    return timelineLevel(view.config.gantt?.zoom);
  }
  return null;
}

/** Advance the selected calendar date by the active window, clamping month
 * ends instead of overflowing January 31 into March. No stored time changes.
 */
export function databaseScheduleNavigationDate(
  view: DatabaseView,
  date: string,
  direction: -1 | 1,
): string {
  const level = databaseScheduleViewLevel(view);
  const result = new Date(`${date}T00:00:00.000Z`);
  if (!level || !Number.isFinite(result.getTime())) return date;
  if (level === "day" || level === "week") {
    result.setUTCDate(
      result.getUTCDate() + direction * (level === "week" ? 7 : 1),
    );
  } else {
    const day = result.getUTCDate();
    result.setUTCDate(1);
    result.setUTCMonth(
      result.getUTCMonth() +
        direction * (level === "year" ? 12 : level === "quarter" ? 3 : 1),
    );
    const lastDay = new Date(
      Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
    ).getUTCDate();
    result.setUTCDate(Math.min(day, lastDay));
  }
  return result.toISOString().slice(0, 10);
}

export function databaseScheduleWindow(
  view: DatabaseView,
  date: string,
  locale: string,
): DatabaseScheduleWindowInput | null {
  const level = databaseScheduleViewLevel(view);
  const fieldId =
    view.viewKind === DatabaseViewKind.Calendar
      ? view.config.calendar?.dateFieldId
      : view.viewKind === DatabaseViewKind.Gantt
        ? view.config.gantt?.startFieldId
        : view.viewKind === DatabaseViewKind.Timeline
          ? view.config.timeline?.startFieldId
          : null;
  if (!level || !fieldId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  if (
    view.viewKind === DatabaseViewKind.Gantt ||
    view.viewKind === DatabaseViewKind.Timeline
  ) {
    const config =
      view.viewKind === DatabaseViewKind.Timeline
        ? view.config.timeline
        : view.config.gantt;
    const day = new Date(`${date}T00:00:00.000Z`);
    if (
      !Number.isFinite(day.getTime()) ||
      day.toISOString().slice(0, 10) !== date
    )
      return null;
    const axis = databaseTemporalAxis(
      date,
      config?.zoom ?? DatabaseTimelineZoom.Month,
      locale,
    );
    return {
      fieldId,
      endFieldId: config?.endFieldId,
      start: new Date(axis.start).toISOString(),
      end: new Date(axis.end - 1).toISOString(),
    };
  }
  const [year, month, day] = date.split("-").map(Number);
  const start = new Date(year, month - 1, day);
  const end = new Date(start);
  if (level === "week") {
    const firstDayIndex = getLocaleWeekStart(locale);
    const offset = (start.getDay() - firstDayIndex + 7) % 7;
    start.setDate(start.getDate() - offset);
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 6);
  } else if (level === "month") {
    start.setDate(1);
    end.setFullYear(start.getFullYear(), start.getMonth() + 1, 0);
  } else if (level === "quarter") {
    start.setMonth(Math.floor(start.getMonth() / 3) * 3, 1);
    end.setFullYear(start.getFullYear(), start.getMonth() + 3, 0);
  } else if (level === "year") {
    start.setMonth(0, 1);
    end.setFullYear(start.getFullYear(), 11, 31);
  }
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  return {
    fieldId,
    endFieldId: null,
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

export function databaseScheduleEvent(
  row: DatabaseRowRecord,
  field: DatabaseField,
): DatabaseScheduleEvent | null {
  const value = getCellValue(row, field.id)?.value;
  if (field.fieldType === DatabaseFieldKind.Date) {
    const start = value?.date?.start;
    if (!start) return null;
    const end = value.date?.end || start;
    return {
      id: row.row.id,
      rowId: row.row.id,
      start: `${start} 00:00:00`,
      end: `${end} 23:59:59`,
      kind: "range",
      title: row.row.title,
    };
  }
  if (field.fieldType !== DatabaseFieldKind.DateTime || !value?.dateTime) {
    return null;
  }
  const dateTime = value.dateTime;
  if (dateTime.allDay) {
    const start = databaseZonedDate(dateTime.start, dateTime.timeZone);
    const end = dateTime.end
      ? databaseZonedDate(dateTime.end, dateTime.timeZone)
      : start;
    return {
      id: row.row.id,
      rowId: row.row.id,
      start: `${start} 00:00:00`,
      end: `${end} 23:59:59`,
      kind: "range",
      title: row.row.title,
    };
  }
  const start = new Date(dateTime.start);
  const end = dateTime.end ? new Date(dateTime.end) : start;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return {
    id: row.row.id,
    rowId: row.row.id,
    start: databaseZonedDateTime(dateTime.start, dateTime.timeZone),
    end: databaseZonedDateTime(
      dateTime.end ?? dateTime.start,
      dateTime.timeZone,
    ),
    kind: dateTime.end ? "range" : "milestone",
    title: row.row.title,
  };
}
