// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  DatabaseCalendarDateMode,
  DatabaseFieldKind,
  DatabaseTimelineZoom,
  DatabaseViewKind,
} from "@myoxus/graphql";
import { describe, expect, test } from "vitest";

import type { DatabaseField, DatabaseRowRecord, DatabaseView } from "../types";
import {
  databaseScheduleEvent,
  databaseScheduleWindow,
  databaseWallTimeToInstant,
  databaseZonedDateTime,
} from "./schedule";

const field = (fieldType: DatabaseFieldKind): DatabaseField =>
  ({ id: "field-date", fieldType }) as DatabaseField;

const row = (value: object): DatabaseRowRecord =>
  ({
    row: { id: "row-1", title: "Release" },
    cells: [{ fieldId: "field-date", value }],
    cellRevisions: [],
    redacted: false,
  }) as unknown as DatabaseRowRecord;

const calendarView = (mode: DatabaseCalendarDateMode): DatabaseView =>
  ({
    id: "view-calendar",
    viewKind: DatabaseViewKind.Calendar,
    config: { calendar: { dateFieldId: "field-date", dateMode: mode } },
  }) as DatabaseView;

const ganttView = {
  id: "view-gantt",
  viewKind: DatabaseViewKind.Gantt,
  config: {
    gantt: {
      startFieldId: "field-start",
      endFieldId: "field-end",
      zoom: DatabaseTimelineZoom.Quarter,
    },
  },
} as DatabaseView;

describe("database schedule projection", () => {
  test("derives an inclusive server window for the visible Mantine month", () => {
    const window = databaseScheduleWindow(
      calendarView(DatabaseCalendarDateMode.Month),
      "2026-07-11",
      "en-US",
    );
    expect(window?.fieldId).toBe("field-date");
    const start = new Date(window?.start ?? "");
    const end = new Date(window?.end ?? "");
    expect(start.getDate()).toBe(1);
    expect(end.getMonth()).toBe(start.getMonth());
    expect(end.getDate()).toBe(31);
    expect(end.getTime() - start.getTime()).toBeGreaterThan(27 * 86_400_000);
  });

  test("matches the Mantine locale week boundary for English and German", () => {
    const view = calendarView(DatabaseCalendarDateMode.Week);
    const english = databaseScheduleWindow(view, "2026-07-08", "en-US");
    const german = databaseScheduleWindow(view, "2026-07-08", "de-DE");

    expect(new Date(english?.start ?? "").getDay()).toBe(0);
    expect(new Date(english?.end ?? "").getDay()).toBe(6);
    expect(new Date(german?.start ?? "").getDay()).toBe(1);
    expect(new Date(german?.end ?? "").getDay()).toBe(0);
  });

  test("projects a Gantt quarter through the same schedule query with its end field", () => {
    const window = databaseScheduleWindow(ganttView, "2026-08-12", "en-US");
    expect(window).toMatchObject({
      fieldId: "field-start",
      endFieldId: "field-end",
    });
    expect(window?.start).toBe("2026-07-01T00:00:00.000Z");
    expect(window?.end).toBe("2026-09-30T23:59:59.999Z");
  });

  test("preserves date ranges and timezone-backed all-day DateTime values", () => {
    expect(
      databaseScheduleEvent(
        row({ date: { start: "2026-07-02", end: "2026-07-05" } }),
        field(DatabaseFieldKind.Date),
      ),
    ).toMatchObject({
      start: "2026-07-02 00:00:00",
      end: "2026-07-05 23:59:59",
      rowId: "row-1",
    });

    expect(
      databaseScheduleEvent(
        row({
          dateTime: {
            allDay: true,
            start: "2026-03-10T04:00:00Z",
            end: "2026-03-12T04:00:00Z",
            timeZone: "America/New_York",
          },
        }),
        field(DatabaseFieldKind.DateTime),
      ),
    ).toMatchObject({
      start: "2026-03-10 00:00:00",
      end: "2026-03-12 23:59:59",
    });
  });

  test("keeps timed ranges and point milestones distinct", () => {
    const range = databaseScheduleEvent(
      row({
        dateTime: {
          allDay: false,
          start: "2026-07-11T09:00:00Z",
          end: "2026-07-11T11:30:00Z",
          timeZone: "Europe/Berlin",
        },
      }),
      field(DatabaseFieldKind.DateTime),
    );
    expect(range).not.toBeNull();
    expect(range).toMatchObject({
      start: "2026-07-11 11:00:00",
      end: "2026-07-11 13:30:00",
    });
    expect(new Date(range!.end).getTime()).toBeGreaterThan(
      new Date(range!.start).getTime(),
    );

    const point = databaseScheduleEvent(
      row({
        dateTime: {
          allDay: false,
          start: "2026-07-11T09:00:00Z",
          end: null,
          timeZone: "UTC",
        },
      }),
      field(DatabaseFieldKind.DateTime),
    );
    expect(point?.end).toBe(point?.start);
  });

  test("roundtrips Mantine wall time through the Cell IANA timezone", () => {
    expect(databaseZonedDateTime("2026-07-11T09:00:00Z", "Europe/Berlin")).toBe(
      "2026-07-11 11:00:00",
    );
    expect(
      databaseWallTimeToInstant("2026-07-11 11:00:00", "Europe/Berlin"),
    ).toBe("2026-07-11T09:00:00.000Z");
  });
});
