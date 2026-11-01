// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  DatabaseFieldKind,
  type BulkDatabaseCellPatchInput,
  type DatabaseCellValueInput,
} from "@myoxus/graphql";
import {
  createCellValueInput,
  getCellValue,
  getDatabaseCellEditRevision,
} from "../model";
import type { DatabaseField, DatabaseRowRecord } from "../types";
import {
  databaseZonedDate,
  databaseZonedDateTime,
  databaseWallTimeToInstant,
} from "./schedule";
export type DatabaseScheduleInterval = {
  allDay: boolean;
  end: number | null;
  row: DatabaseRowRecord;
  start: number;
  timeZone: string;
};
export type ScheduleTimeIntent = {
  start: number;
  end: number;
  mode: "move" | "resize-start" | "resize-end";
};
/** Reject normalized dates (for example February 31) and non-date suffixes. */
export function scheduleCalendarDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? date.getTime()
    : null;
}

function scheduleInstant(value: string): number | null {
  const parts =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (
    !parts ||
    scheduleCalendarDay(parts[1]!) === null ||
    Number(parts[2]) > 23 ||
    Number(parts[3]) > 59 ||
    Number(parts[4]) > 59
  )
    return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? instant : null;
}

/** Wrap the shared wall-time helper with a strict IANA calendar roundtrip.
 * Calendar retains its existing conversion semantics.
 */
export function scheduleWallTimeToInstant(
  wallTime: string,
  timeZone: string,
): string | null {
  if (
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(wallTime) ||
    scheduleCalendarDay(wallTime.slice(0, 10)) === null
  )
    return null;
  try {
    const result = databaseWallTimeToInstant(wallTime, timeZone);
    return result && databaseZonedDateTime(result, timeZone) === wallTime
      ? result
      : null;
  } catch {
    return null;
  }
}

type ScheduleFieldInterval = Omit<DatabaseScheduleInterval, "row">;
export type ScheduleFieldResolution =
  | { kind: "missing" | "invalid" }
  | { kind: "ready"; interval: ScheduleFieldInterval };

/** All-day DateTime is positioned by its stored IANA calendar date. Its
 * persisted instant is left intact until the mutation owner changes a boundary.
 */
export function scheduleFieldInterval(
  row: DatabaseRowRecord,
  field: DatabaseField,
): ScheduleFieldResolution {
  return scheduleFieldValueInterval(field, getCellValue(row, field.id)?.value);
}

/** Resolve persisted values and local input previews through the same strict
 * calendar contract; previewing never materializes a fake server cell.
 */
export function scheduleFieldValueInterval(
  field: DatabaseField,
  cell?:
    | (Pick<DatabaseCellValueInput, "date" | "dateTime"> & {
        createdTime?: string | null;
        updatedTime?: string | null;
      })
    | null,
): ScheduleFieldResolution {
  const date = field.fieldType === DatabaseFieldKind.Date ? cell?.date : null;
  const dateTime =
    field.fieldType === DatabaseFieldKind.DateTime ? cell?.dateTime : null;
  const metadata =
    field.fieldType === DatabaseFieldKind.CreatedTime
      ? cell?.createdTime
      : field.fieldType === DatabaseFieldKind.UpdatedTime
        ? cell?.updatedTime
        : null;
  const value = date ?? dateTime;
  if (!value && !metadata) return { kind: "missing" };
  if (!value && typeof metadata !== "string") return { kind: "invalid" };
  const allDay = Boolean(date || dateTime?.allDay);
  const timeZone = dateTime?.timeZone ?? "UTC";
  const boundary = (raw: string) => {
    if (date) return scheduleCalendarDay(raw);
    const instant = scheduleInstant(raw);
    if (instant === null) return null;
    return allDay
      ? scheduleCalendarDay(databaseZonedDate(raw, timeZone))
      : instant;
  };
  try {
    const rawStart = value?.start ?? metadata;
    if (typeof rawStart !== "string") return { kind: "invalid" };
    const start = boundary(rawStart);
    const rawEnd = value?.end;
    if (rawEnd && typeof rawEnd !== "string") return { kind: "invalid" };
    const end = typeof rawEnd === "string" && rawEnd ? boundary(rawEnd) : null;
    if (start === null || (value?.end && end === null))
      return { kind: "invalid" };
    // A separate end field contributes its start, but its stored range still
    // has to be valid. All-day rendering must not hide an inverted instant.
    if (
      typeof rawEnd === "string" &&
      rawEnd &&
      (date
        ? end! < start
        : scheduleInstant(rawEnd)! < scheduleInstant(rawStart)!)
    )
      return { kind: "invalid" };
    return { kind: "ready", interval: { allDay, start, end, timeZone } };
  } catch {
    return { kind: "invalid" };
  }
}

export type ScheduleRowDiagnostic = {
  row: DatabaseRowRecord;
  reason:
    | "missing-start"
    | "invalid-start"
    | "missing-end"
    | "invalid-end"
    | "end-before-start";
};

export function scheduleRowIntervals(
  rows: DatabaseRowRecord[],
  startField: DatabaseField,
  endField: DatabaseField | null,
) {
  const intervals: DatabaseScheduleInterval[] = [];
  const diagnostics: ScheduleRowDiagnostic[] = [];
  for (const row of rows) {
    if (row.redacted || row.row.deletedAt) continue;
    const start = scheduleFieldInterval(row, startField);
    if (start.kind !== "ready") {
      diagnostics.push({
        row,
        reason: start.kind === "missing" ? "missing-start" : "invalid-start",
      });
      continue;
    }
    const configuredEnd = endField
      ? scheduleFieldInterval(row, endField)
      : null;
    if (configuredEnd?.kind === "invalid") {
      diagnostics.push({
        row,
        reason: "invalid-end",
      });
      continue;
    }
    // A separate field always contributes its start. Its own range end must
    // never override this boundary. An empty separate cell is a point; it
    // must not inherit the start cell's unrelated range end.
    const end =
      configuredEnd?.kind === "ready"
        ? configuredEnd.interval.start
        : endField
          ? null
          : start.interval.end;
    if (end !== null && end < start.interval.start) {
      diagnostics.push({ row, reason: "end-before-start" });
      continue;
    }
    intervals.push({ ...start.interval, end, row });
  }
  return { intervals, diagnostics };
}

/** Preserve stored sub-millisecond precision that JS geometry cannot represent. */
function preserveInstantFraction(instant: string, basis?: string | null) {
  const fraction = basis?.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1];
  return fraction && fraction.length > 3
    ? instant.replace(
        /\.(\d{3})Z$/,
        (_, millis: string) => `.${millis}${fraction.slice(3)}Z`,
      )
    : instant;
}

/** Serialize one editable boundary without dropping the cell's other endpoint. */
export function scheduleCellValue(
  field: DatabaseField,
  start: number,
  end: number | null,
  existing: { allDay: boolean; timeZone: string } | null,
  previous?: { start: string; end?: string | null } | null,
) {
  if (field.fieldType === DatabaseFieldKind.Date) {
    if (end !== null && end < start) throw new Error("end-before-start");
    return {
      date: {
        start: new Date(start).toISOString().slice(0, 10),
        end: end === null ? null : new Date(end).toISOString().slice(0, 10),
      },
    };
  }
  const timeZone =
    existing?.timeZone || field.config.dateTime?.defaultTimeZone || "UTC";
  const boundary = (value: number, basis?: string | null) => {
    if (!existing?.allDay) {
      if (basis && Date.parse(basis) === value) return basis;
      return preserveInstantFraction(new Date(value).toISOString(), basis);
    }
    // Geometry is in calendar days. Convert each boundary in its own stored
    // zone; adding UTC milliseconds across DST would change its calendar day.
    const calendarDay = new Date(value).toISOString().slice(0, 10);
    if (basis && databaseZonedDate(basis, timeZone) === calendarDay)
      return basis;
    const clock = basis
      ? databaseZonedDateTime(basis, timeZone).slice(11)
      : "00:00:00";
    const instant = scheduleWallTimeToInstant(
      `${calendarDay} ${clock}`,
      timeZone,
    );
    if (!instant)
      throw new Error("Database time is invalid in its stored time zone.");
    const fraction = basis ? new Date(basis).getUTCMilliseconds() : 0;
    return preserveInstantFraction(
      new Date(Date.parse(instant) + fraction).toISOString(),
      basis,
    );
  };
  const nextStart = boundary(start, previous?.start);
  const nextEnd = end === null ? null : boundary(end, previous?.end);
  // Separate-field moves retain each cell's unrelated range end. Block a
  // changed start that would invert that range before sending any patch.
  if (nextEnd !== null && Date.parse(nextEnd) < Date.parse(nextStart))
    throw new Error("end-before-start");
  return createCellValueInput(field, {
    allDay: existing?.allDay ?? false,
    start: nextStart,
    end: nextEnd,
    timeZone,
  });
}

function scheduleCell(
  row: DatabaseRowRecord,
  field: DatabaseField,
  start: number,
  end: number | null,
): BulkDatabaseCellPatchInput {
  const resolved = scheduleFieldInterval(row, field);
  return {
    fieldId: field.id,
    value: scheduleCellValue(
      field,
      start,
      end,
      resolved.kind === "ready" ? resolved.interval : null,
      getCellValue(row, field.id)?.value.dateTime,
    ),
    expectedEditRevision: getDatabaseCellEditRevision(row, field.id),
  };
}

function fieldRangeEnd(row: DatabaseRowRecord, field: DatabaseField) {
  const resolved = scheduleFieldInterval(row, field);
  return resolved.kind === "ready" ? resolved.interval.end : null;
}

/** A move owns both boundaries in one transaction; resize owns only its edge. */
export function scheduleChangedTimeCells(
  item: DatabaseScheduleInterval,
  startField: DatabaseField,
  endField: DatabaseField | null,
  intent: ScheduleTimeIntent,
): BulkDatabaseCellPatchInput[] {
  if (
    !Number.isFinite(intent.start) ||
    !Number.isFinite(intent.end) ||
    intent.end < intent.start
  )
    return [];
  const startResolution = scheduleFieldInterval(item.row, startField);
  const endResolution = endField
    ? scheduleFieldInterval(item.row, endField)
    : startResolution;
  const calendarBoundary = (value: number) =>
    Math.round(value / 86_400_000) * 86_400_000;
  intent = {
    ...intent,
    start:
      startResolution.kind === "ready" && startResolution.interval.allDay
        ? calendarBoundary(intent.start)
        : intent.start,
    end:
      endResolution?.kind === "ready" && endResolution.interval.allDay
        ? calendarBoundary(intent.end)
        : intent.end,
  };
  if (intent.end < intent.start) return [];
  if (intent.start === item.start && intent.end === (item.end ?? item.start))
    return [];
  if (!endField) {
    return [
      scheduleCell(
        item.row,
        startField,
        intent.start,
        item.end === null ? null : intent.end,
      ),
    ];
  }
  const cells: BulkDatabaseCellPatchInput[] = [];
  if (intent.mode !== "resize-end" && intent.start !== item.start) {
    cells.push(
      scheduleCell(
        item.row,
        startField,
        intent.start,
        fieldRangeEnd(item.row, startField),
      ),
    );
  }
  if (
    intent.mode !== "resize-start" &&
    item.end !== null &&
    intent.end !== item.end
  ) {
    cells.push(
      scheduleCell(
        item.row,
        endField,
        intent.end,
        fieldRangeEnd(item.row, endField),
      ),
    );
  }
  return cells;
}
