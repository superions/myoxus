// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Journal calendar sidecard body. */
import { getFirstDayOfWeek } from "@myoxus/core/modules/journal/dayjs-week-config";
import { useI18n } from "@myoxus/i18n";
import {
  Alert,
  Button,
  type DateCell,
  DatePicker,
  DatePickerDayContent,
  Loading,
  MiniCalendar,
  SidebarCalendarPanel,
  SidebarControlStrip,
  Stack,
  ViewSwitcher,
} from "@myoxus/ui-facade";
import { useCallback } from "react";

import type { CalendarView } from "./event-sections";
import { JournalSidebarFooter } from "./sidebar-footer";
import { useJournalToolState } from "./tool-state";

export function JournalCalendarToolBody() {
  const t = useI18n();
  const {
    allJournalDates,
    calendarError,
    calendarLoading,
    eventCountForDate,
    eventDateColor,
    eventDates,
    isJournal,
    onCalendarCursorChange,
    onDateSelect,
    onViewChange,
    refreshCalendar,
    selectedDate,
    showWeekNumbers,
    view,
  } = useJournalToolState();
  const customDayRenderer = useCallback(
    (cell: DateCell) => {
      const dateKey = cell.date.format("YYYY-MM-DD");
      return (
        <DatePickerDayContent
          indicator={eventDates.has(dateKey)}
          indicatorColor={eventDateColor(dateKey)}
        >
          {cell.label}
        </DatePickerDayContent>
      );
    },
    [eventDateColor, eventDates],
  );
  const dayButtonProps = useCallback(
    (cell: DateCell) => {
      const dateKey = cell.date.format("YYYY-MM-DD");
      const eventCount = eventCountForDate(dateKey);
      return {
        "aria-label": eventCount
          ? t["com.myoxus.integration.calendar.dot-aria-label"]({
              count: String(eventCount),
            })
          : undefined,
        "data-has-journal": allJournalDates.has(dateKey),
        "data-is-date-cell": true,
        "data-is-today": cell.isToday,
        "data-not-current-month": cell.notCurrentMonth,
        tabIndex: cell.focused ? 0 : -1,
      };
    },
    [allJournalDates, eventCountForDate, t],
  );

  return (
    <Stack
      data-view={view}
      data-myoxus-ui-role="journal-calendar-tool"
      data-testid="journal-calendar-tool"
    >
      {calendarError ? (
        <Alert
          data-testid="journal-calendar-error"
          title={t["com.myoxus.integration.calendar.provider.load-error"]()}
        >
          <Button variant="secondary" onClick={() => void refreshCalendar()}>
            {t["com.myoxus.sidebar.action.refresh"]()}
          </Button>
        </Alert>
      ) : null}
      {calendarLoading ? (
        <Loading data-testid="journal-calendar-loading" />
      ) : null}
      {/* Keep the calendar's native cursor mounted while its requested month
          loads; remounting from selectedDate would cancel month navigation. */}
      <SidebarControlStrip
        data-myoxus-ui-role="calendar-view-switcher"
        data-testid="calendar-view-switcher"
      >
        <ViewSwitcher<CalendarView>
          layout="sidebar"
          value={view}
          aria-label={t["com.myoxus.integration.calendar.view.label"]()}
          data-myoxus-ui-role="calendar-view-segmented-control"
          items={[
            {
              value: "month",
              label: t["com.myoxus.integration.calendar.view.month"](),
              testId: "calendar-view-month",
            },
            {
              value: "week",
              label: t["com.myoxus.integration.calendar.view.week"](),
              testId: "calendar-view-week",
            },
            {
              value: "day",
              label: t["com.myoxus.integration.calendar.view.day"](),
              testId: "calendar-view-day",
            },
          ]}
          onChange={onViewChange}
        />
      </SidebarControlStrip>
      {view === "month" ? (
        <SidebarCalendarPanel data-myoxus-ui-role="calendar-panel">
          <DatePicker
            firstDayOfWeek={getFirstDayOfWeek()}
            weekDays={t["com.myoxus.common.calendar.week-days"]()}
            monthNames={t["com.myoxus.common.calendar.month-names"]()}
            todayLabel={t["com.myoxus.common.calendar.today"]()}
            showTodayLink={false}
            customDayRenderer={customDayRenderer}
            dayButtonProps={dayButtonProps}
            value={selectedDate.format("YYYY-MM-DD")}
            onChange={onDateSelect}
            onCursorChange={onCalendarCursorChange}
            selectionVariant={isJournal ? "filled" : "outline"}
            showWeekNumbers={showWeekNumbers}
          />
        </SidebarCalendarPanel>
      ) : null}
      {view === "week" ? (
        <SidebarCalendarPanel data-myoxus-ui-role="calendar-panel">
          <MiniCalendar
            value={selectedDate.format("YYYY-MM-DD")}
            onChange={onDateSelect}
            firstDayOfWeek={getFirstDayOfWeek()}
            locale={t.language}
            previousLabel={t["com.myoxus.lastWeek"]()}
            nextLabel={t["com.myoxus.nextWeek"]()}
            data-testid="calendar-week-picker"
            dayTestId="calendar-week-day"
            layout="sidebar"
            numberOfDays={7}
          />
        </SidebarCalendarPanel>
      ) : null}
      {view === "day" ? (
        <SidebarCalendarPanel
          data-myoxus-ui-role="calendar-panel"
          data-testid="calendar-day-stepper"
        >
          <MiniCalendar
            value={selectedDate.format("YYYY-MM-DD")}
            onChange={onDateSelect}
            firstDayOfWeek={getFirstDayOfWeek()}
            data-testid="calendar-day-picker"
            dayTestId="calendar-day-label"
            locale={t.language}
            layout="sidebar"
            monthLabelFormat="dddd"
            nextLabel={t["com.myoxus.integration.calendar.view.next-day"]()}
            nextTestId="calendar-day-next"
            numberOfDays={1}
            previousLabel={t[
              "com.myoxus.integration.calendar.view.previous-day"
            ]()}
            previousTestId="calendar-day-prev"
          />
        </SidebarCalendarPanel>
      ) : null}
      <JournalSidebarFooter />
    </Stack>
  );
}
