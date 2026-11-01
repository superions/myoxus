// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DatabaseTimelineGroupBy,
  DatabaseTimelineOrder,
  DatabaseTimelineZoom,
} from "@myoxus/graphql";
import {
  getLocaleWeekStart,
  temporalOverlaps,
  type TimeTimelineEntry,
  type TimeTimelineGroup,
} from "@myoxus/ui-facade";
import { getDatabaseDateField } from "../shared/date-source";
import { databaseZonedDate } from "../shared/schedule";
import {
  scheduleRowIntervals,
  scheduleFieldInterval,
  type DatabaseScheduleInterval,
} from "../shared/schedule-values";
import {
  databaseTemporalAxis,
  databaseTemporalTicks,
} from "../shared/temporal";
import { isDatabaseProjectionField } from "../model";
import type {
  DatabaseField,
  DatabaseRecord,
  DatabaseRowRecord,
  DatabaseView,
} from "../types";

/** Group the stored calendar date; UTC arithmetic only advances that calendar. */
function groupRange(
  item: DatabaseScheduleInterval,
  groupBy: DatabaseTimelineGroupBy,
  locale: string,
) {
  const day = item.allDay
    ? new Date(item.start).toISOString().slice(0, 10)
    : databaseZonedDate(new Date(item.start).toISOString(), item.timeZone);
  const date = new Date(`${day}T00:00:00Z`);
  if (groupBy === DatabaseTimelineGroupBy.None)
    return { key: "all", start: null, end: null };
  if (groupBy === DatabaseTimelineGroupBy.Month) {
    date.setUTCDate(1);
    const end = new Date(date);
    end.setUTCMonth(end.getUTCMonth() + 1);
    end.setUTCDate(0);
    return { key: `month:${date.toISOString().slice(0, 7)}`, start: date, end };
  }
  if (groupBy === DatabaseTimelineGroupBy.Week) {
    date.setUTCDate(
      date.getUTCDate() -
        ((date.getUTCDay() - getLocaleWeekStart(locale) + 7) % 7),
    );
    const end = new Date(date);
    end.setUTCDate(end.getUTCDate() + 6);
    return { key: `week:${date.toISOString().slice(0, 10)}`, start: date, end };
  }
  return { key: `day:${day}`, start: date, end: date };
}
function groupIntervals(
  intervals: DatabaseScheduleInterval[],
  groupBy: DatabaseTimelineGroupBy,
  order: DatabaseTimelineOrder,
  locale: string,
) {
  const groups = new Map<
    string,
    { key: string; label: string | null; entries: DatabaseScheduleInterval[] }
  >();
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  });
  for (const item of intervals) {
    const range = groupRange(item, groupBy, locale);
    let group = groups.get(range.key);
    if (!group) {
      const label =
        range.start === null
          ? null
          : groupBy === DatabaseTimelineGroupBy.Month
            ? new Intl.DateTimeFormat(locale, {
                month: "long",
                year: "numeric",
                timeZone: "UTC",
              }).format(range.start)
            : range.end!.getTime() === range.start.getTime()
              ? formatter.format(range.start)
              : formatter.formatRange(range.start, range.end!);
      group = { key: range.key, label, entries: [] };
      groups.set(range.key, group);
    }
    // Iteration preserves the server's effective order within every group.
    group.entries.push(item);
  }
  return [...groups.values()].sort((a, b) =>
    groupBy === DatabaseTimelineGroupBy.None
      ? 0
      : (order === DatabaseTimelineOrder.Desc ? -1 : 1) *
        a.key.localeCompare(b.key),
  );
}
export function databaseTimelineGroups(
  rows: DatabaseRowRecord[],
  startField: DatabaseField,
  endField: DatabaseField | null,
  groupBy: DatabaseTimelineGroupBy,
  order: DatabaseTimelineOrder,
  locale: string,
) {
  return groupIntervals(
    scheduleRowIntervals(rows, startField, endField).intervals,
    groupBy,
    order,
    locale,
  ).map((group) => ({
    ...group,
    entries: group.entries.map((item) => ({
      row: item.row,
      start: new Date(item.start),
      end: item.end === null ? null : new Date(item.end),
    })),
  }));
}
export function timelineIntervalLabel(
  item: DatabaseScheduleInterval,
  locale: string,
  endField?: DatabaseField | null,
  endContext?: { allDay: boolean; timeZone: string },
) {
  const endResolution = endField
    ? scheduleFieldInterval(item.row, endField)
    : null;
  const last =
    endContext ??
    (endResolution?.kind === "ready" ? endResolution.interval : item);
  const formatter = (boundary: { allDay: boolean; timeZone: string }) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      ...(boundary.allDay ? {} : { timeStyle: "medium" as const }),
      timeZone: boundary.allDay ? "UTC" : boundary.timeZone,
    });
  const single = (
    value: number,
    boundary: { allDay: boolean; timeZone: string },
  ) =>
    `${formatter(boundary).format(value)}${boundary.allDay ? "" : ` (${boundary.timeZone})`}`;
  if (item.end === null) return single(item.start, item);
  // Mixed fields retain their own calendars and zones in the visible labels.
  if (item.allDay !== last.allDay || item.timeZone !== last.timeZone)
    return `${single(item.start, item)} – ${single(item.end, last)}`;
  return `${formatter(item).formatRange(item.start, item.end)}${item.allDay ? "" : ` (${item.timeZone})`}`;
}
/** One server Row becomes one event. Invalid rows remain readable diagnostics. */
export function projectDatabaseTimeline(
  record: DatabaseRecord,
  rows: DatabaseRowRecord[],
  view: DatabaseView,
  date: string,
  locale: string,
  selectedId: string | null,
  readonlyReason: string,
  preview?: DatabaseScheduleInterval | null,
) {
  const config = view.config.timeline;
  const startField = getDatabaseDateField(record, config?.startFieldId) ?? null;
  const endField = getDatabaseDateField(record, config?.endFieldId) ?? null;
  const validConfig = Boolean(
    startField &&
    (!config?.endFieldId || endField) &&
    startField.id !== endField?.id,
  );
  const zoom = config?.zoom ?? DatabaseTimelineZoom.Month;
  const bounds = databaseTemporalAxis(date, zoom, locale);
  const axis = {
    ...bounds,
    kind: "time" as const,
    ticks: databaseTemporalTicks(bounds, locale, zoom),
  };
  const resolved =
    validConfig && startField
      ? scheduleRowIntervals(rows, startField, endField)
      : { intervals: [], diagnostics: [] };
  const intervals = resolved.intervals
    .map((item) =>
      item.row.row.id === preview?.row.row.id
        ? { ...preview, row: item.row }
        : item,
    )
    .filter(
      (item) =>
        item.row.row.id === preview?.row.row.id ||
        temporalOverlaps(
          { start: item.start, end: item.end ?? undefined },
          axis,
        ),
    );
  const groups: TimeTimelineGroup[] = groupIntervals(
    intervals,
    config?.groupBy ?? DatabaseTimelineGroupBy.None,
    config?.order ?? DatabaseTimelineOrder.Asc,
    locale,
  ).map((group) => ({
    id: group.key,
    label: group.label,
    entries: group.entries.map((item) => {
      const timeLabel = timelineIntervalLabel(item, locale, endField);
      const endResolution = endField
        ? scheduleFieldInterval(item.row, endField)
        : null;
      const endCalendar =
        endResolution?.kind === "ready"
          ? endResolution.interval.allDay
          : item.allDay;
      const calendarMove = item.allDay && (item.end === null || endCalendar);
      const reason = [startField, endField].some(
        (field) => field && isDatabaseProjectionField(field.fieldType),
      )
        ? readonlyReason
        : "";
      return {
        id: item.row.row.id,
        label: item.row.row.title,
        start: item.start,
        end: item.end,
        timeLabel,
        selected: selectedId === item.row.row.id,
        timeActions: {
          move: {
            enabled: ![startField, endField].some(
              (field) => field && isDatabaseProjectionField(field.fieldType),
            ),
            reason,
          },
          start: {
            enabled:
              item.end !== null &&
              Boolean(
                startField && !isDatabaseProjectionField(startField.fieldType),
              ),
            reason,
          },
          end: {
            enabled:
              item.end !== null &&
              Boolean(
                (endField ?? startField) &&
                !isDatabaseProjectionField((endField ?? startField)!.fieldType),
              ),
            reason,
          },
          moveStep: calendarMove
            ? 86400000
            : item.allDay || endCalendar
              ? Math.max(86400000, axis.step)
              : axis.step,
          startStep: item.allDay ? 86400000 : axis.step,
          endStep: endCalendar ? 86400000 : axis.step,
        },
        accessibleLabel: [item.row.row.title, timeLabel, group.label, reason]
          .filter(Boolean)
          .join(", "),
      } satisfies TimeTimelineEntry;
    }),
  }));
  return {
    axis,
    groups,
    intervals,
    startField,
    endField,
    validConfig,
    startEditable: Boolean(
      startField && !isDatabaseProjectionField(startField.fieldType),
    ),
    endEditable: Boolean(
      (endField ?? startField) &&
      !isDatabaseProjectionField((endField ?? startField)!.fieldType),
    ),
    diagnostics: resolved.diagnostics,
    intervalById: new Map(intervals.map((item) => [item.row.row.id, item])),
  };
}

/** Locale values for the neutral preview; edit precision never sizes the axis. */
export function timelineTimePreviewValues(
  source: DatabaseScheduleInterval,
  target: DatabaseScheduleInterval,
  endField: DatabaseField | null,
  step: number,
  locale: string,
) {
  const unit = step >= 86400000 ? "day" : "hour";
  return {
    source: timelineIntervalLabel(source, locale, endField),
    target: timelineIntervalLabel(target, locale, endField),
    duration: new Intl.NumberFormat(locale, {
      style: "unit",
      unit: source.allDay ? "day" : "second",
      unitDisplay: "long",
      maximumFractionDigits: 3,
    }).format(
      target.end === null
        ? 0
        : (target.end - target.start) / (source.allDay ? 86400000 : 1000),
    ),
    step: new Intl.NumberFormat(locale, {
      style: "unit",
      unit,
      unitDisplay: "long",
    }).format(step / (unit === "day" ? 86400000 : 3600000)),
  };
}
