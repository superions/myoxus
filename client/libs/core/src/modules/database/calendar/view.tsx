// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  DatabaseCalendarView as FacadeDatabaseCalendarView,
  EmptyState,
  Stack,
} from "@myoxus/ui-facade";

import { DatabasePresenceTarget } from "../presence/database-presence-target";
import { useDatabaseRowDetail } from "../row-detail";
import {
  databaseScheduleEvent,
  databaseScheduleViewLevel,
  getDatabaseDateField,
} from "../shared";
import type { DatabaseRecord, DatabaseRowRecord, DatabaseView } from "../types";

export function DatabaseCalendarView({
  date,
  onDateChange,
  record,
  rows,
  view,
}: {
  date: string;
  onDateChange: (date: string) => void;
  record: DatabaseRecord;
  rows: DatabaseRowRecord[];
  view: DatabaseView;
}) {
  const t = useI18n();
  const rowDetail = useDatabaseRowDetail();
  const dateField = getDatabaseDateField(
    record,
    view.config.calendar?.dateFieldId,
  );

  if (!dateField) {
    return (
      <EmptyState
        title={t["com.myoxus.database.calendar.invalid-title"]()}
        description={t["com.myoxus.database.calendar.invalid-description"]()}
      />
    );
  }

  const events = rows.flatMap((row) => {
    const event = databaseScheduleEvent(row, dateField);
    return event ? [event] : [];
  });
  const scheduleLevel = databaseScheduleViewLevel(view);

  return (
    <Stack data-testid="database-calendar-view">
      <FacadeDatabaseCalendarView
        date={date}
        data-testid="database-calendar-schedule"
        events={events}
        labels={{
          allDay: t["com.myoxus.integration.calendar.all-day"](),
          day: t["com.myoxus.integration.calendar.view.day"](),
          month: t["com.myoxus.integration.calendar.view.month"](),
          more: t["com.myoxus.integration.calendar.view.more"](),
          moreLabel: (count) =>
            t["com.myoxus.integration.calendar.view.more-count"]({
              count: String(count),
            }),
          next: t["common.next"](),
          noEvents: t["com.myoxus.integration.calendar.no-events"](),
          previous: t["common.previous"](),
          selectMonth: t["com.myoxus.integration.calendar.view.select-month"](),
          selectYear: t["com.myoxus.integration.calendar.view.select-year"](),
          switchToDayView: t["com.myoxus.integration.calendar.view.day-aria"](),
          switchToMonthView:
            t["com.myoxus.integration.calendar.view.month-aria"](),
          switchToWeekView:
            t["com.myoxus.integration.calendar.view.week-aria"](),
          switchToYearView:
            t["com.myoxus.integration.calendar.view.year-aria"](),
          timeSlot: t["com.myoxus.integration.calendar.view.time-slot"](),
          today: t["com.myoxus.integration.calendar.view.today"](),
          viewSelectLabel: t["com.myoxus.integration.calendar.view.label"](),
          week: t["com.myoxus.integration.calendar.view.week"](),
          weekday: t["com.myoxus.integration.calendar.view.weekday"](),
          year: t["com.myoxus.integration.calendar.view.year"](),
        }}
        locale={t.language}
        renderEventBody={(event) => (
          <DatabasePresenceTarget
            rowId={event.rowId ?? event.id}
            viewId={view.id}
          >
            {event.title}
          </DatabasePresenceTarget>
        )}
        view={
          scheduleLevel === "quarter" ? "month" : (scheduleLevel ?? "month")
        }
        onDateChange={onDateChange}
        onEventSelect={(event) => {
          const row = rows.find(
            (candidate) => candidate.row.id === event.rowId,
          );
          if (row) rowDetail?.open(row);
        }}
      />
    </Stack>
  );
}
