// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Shared calendar, agenda and journal-activity sidecard state. */
import { DocService } from "@myoxus/core/modules/doc";
import { IntegrationService } from "@myoxus/core/modules/integration";
import { JournalService } from "@myoxus/core/modules/journal";
import {
  UserPreferencesService,
  WorkspaceServerService,
} from "@myoxus/core/modules/server";
import { ViewService, WorkbenchService } from "@myoxus/core/modules/workbench";
import { useLiveData, useService, useServiceOptional } from "@myoxus/infra";
import dayjs, { type Dayjs } from "dayjs";
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { CalendarView } from "./event-sections";

const VIEW_STORAGE_KEY = "myoxus-journal-calendar-view";
const JOURNAL_ROUTE_RE = /(?:^|\/)journals(?:\/|$)/;

function browserLocation() {
  if (typeof window === "undefined") {
    return { pathname: "", search: "" };
  }
  return {
    pathname: window.location.pathname,
    search: window.location.search,
  };
}

function readStoredView(): CalendarView {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE_KEY);
    if (raw === "month" || raw === "week" || raw === "day") return raw;
  } catch {
    // Storage is optional; the default view remains usable without it.
  }
  return "month";
}

function writeStoredView(value: CalendarView): void {
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, value);
  } catch {
    // Storage is optional; the current session still keeps the selected view.
  }
}

export interface JournalToolState {
  allJournalDates: ReadonlySet<string>;
  calendarCursor: Dayjs;
  calendarError: unknown;
  calendarLoading: boolean;
  eventCountForDate: (date: string) => number;
  eventDateColor: (date: string) => string | null;
  eventDates: ReadonlySet<string>;
  isJournal: boolean;
  onCalendarCursorChange: (date: Dayjs) => void;
  onDateSelect: (date: string) => void;
  onViewChange: (view: CalendarView) => void;
  readonly: boolean;
  refreshCalendar: () => Promise<void>;
  selectedDate: Dayjs;
  showWeekNumbers: boolean;
  view: CalendarView;
}

const JournalToolStateContext = createContext<JournalToolState | null>(null);

export function JournalToolStateProvider({
  children,
  readonly = false,
}: PropsWithChildren<{ readonly?: boolean }>) {
  const doc = useServiceOptional(DocService)?.doc;
  const workbench = useService(WorkbenchService).workbench;
  const viewService = useService(ViewService);
  const journalService = useService(JournalService);
  const calendar = useService(IntegrationService).calendar;
  const workspaceServerService = useService(WorkspaceServerService);
  const userPreferencesService = useService(UserPreferencesService);
  const userPreferences = useLiveData(userPreferencesService.userPreferences$);
  const server = useLiveData(workspaceServerService.server$);
  const location = useLiveData(viewService.view.location$);
  const toolLayout = useLiveData(viewService.view.toolLayout$);
  const calendarDataRequired = toolLayout.visibleToolIds.some(
    (toolId) => toolId === "calendar" || toolId === "agenda",
  );
  const journalDate$ = useMemo(
    () => (doc ? journalService.journalDate$(doc.id) : null),
    [doc, journalService],
  );
  const journalDateStr = useLiveData(journalDate$);
  const journalDate = journalDateStr ? dayjs(journalDateStr) : null;
  const isJournal = Boolean(journalDate);
  const routeDate = useMemo(() => {
    const browser = browserLocation();
    const pathname = JOURNAL_ROUTE_RE.test(location.pathname)
      ? location.pathname
      : browser.pathname;
    if (!JOURNAL_ROUTE_RE.test(pathname)) return null;
    const searchParams = new URLSearchParams(location.search || browser.search);
    const rawDate = searchParams.get("date");
    return rawDate ? dayjs(rawDate) : dayjs();
  }, [location.pathname, location.search]);
  const [selectedDate, setSelectedDate] = useState(
    () => journalDate ?? routeDate ?? dayjs(),
  );
  const [calendarCursor, setCalendarCursor] = useState(selectedDate);
  const [view, setView] = useState<CalendarView>(() => readStoredView());
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [calendarError, setCalendarError] = useState<unknown>(null);
  const calendarMonthKey = calendarCursor.format("YYYY-MM");
  const calendarMonthStart = useMemo(
    () => dayjs(`${calendarMonthKey}-01`),
    [calendarMonthKey],
  );
  const calendarMonthEnd = useMemo(
    () => dayjs(`${calendarMonthKey}-01`).endOf("month"),
    [calendarMonthKey],
  );
  const allJournalDates = useLiveData(journalService.allJournalDates$);
  const eventDates = useLiveData(calendar.eventDates$);
  const eventDateColors = useLiveData(calendar.eventDateColors$);
  const eventCountByDate = useLiveData(calendar.eventsByDateMap$);
  const workspaceCalendars = useLiveData(calendar.workspaceCalendars$);
  const workspaceCalendarId = workspaceCalendars[0]?.id;

  useEffect(() => {
    if (journalDate && !journalDate.isSame(selectedDate, "day")) {
      setSelectedDate(journalDate);
    }
  }, [journalDate, selectedDate]);

  useEffect(() => {
    if (journalDate || !routeDate) return;
    if (!routeDate.isSame(selectedDate, "day")) {
      setSelectedDate(routeDate);
    }
  }, [journalDate, routeDate, selectedDate]);

  useEffect(() => {
    setCalendarCursor(selectedDate);
  }, [selectedDate]);

  const openJournal = useCallback(
    (date: string) => {
      const docs = journalService.getJournalsByDate(date);
      if (docs.length > 0) {
        workbench.openDoc(docs[0].id, { at: "active" });
      } else {
        workbench.open(`/journals?date=${date}`, { at: "active" });
      }
    },
    [journalService, workbench],
  );

  const onDateSelect = useCallback(
    (date: string) => {
      const nextDate = dayjs(date);
      setSelectedDate(nextDate);
      if (!isJournal || !nextDate.isSame(journalDate, "day")) {
        openJournal(date);
      }
    },
    [isJournal, journalDate, openJournal],
  );

  const refreshCalendar = useCallback(async () => {
    setCalendarLoading(true);
    setCalendarError(null);
    try {
      await Promise.all([
        calendar.revalidateWorkspaceCalendars(),
        calendar.loadAccountCalendars(),
        calendar.revalidateEventsRange(calendarMonthStart, calendarMonthEnd),
      ]);
    } catch (error) {
      setCalendarError(error);
    } finally {
      setCalendarLoading(false);
    }
  }, [calendar, calendarMonthEnd, calendarMonthStart]);

  useEffect(() => {
    if (!calendarDataRequired) return;
    void refreshCalendar();
    const interval = setInterval(
      () => {
        calendar
          .revalidateEventsRange(calendarMonthStart, calendarMonthEnd)
          .catch(setCalendarError);
      },
      5 * 60 * 1000,
    );
    return () => clearInterval(interval);
  }, [
    calendar,
    calendarDataRequired,
    calendarMonthEnd,
    calendarMonthStart,
    refreshCalendar,
    server,
    workspaceCalendarId,
  ]);

  const onViewChange = useCallback((nextView: CalendarView) => {
    setView(nextView);
    writeStoredView(nextView);
  }, []);
  const eventCountForDate = useCallback(
    (date: string) => eventCountByDate.get(date)?.length ?? 0,
    [eventCountByDate],
  );
  const eventDateColor = useCallback(
    (date: string) => eventDateColors.get(date) ?? null,
    [eventDateColors],
  );
  const showWeekNumbers =
    userPreferences?.effectiveValues.journalShowCalendarWeeks ?? true;
  const model = useMemo<JournalToolState>(
    () => ({
      allJournalDates,
      calendarCursor,
      calendarError,
      calendarLoading,
      eventCountForDate,
      eventDateColor,
      eventDates,
      isJournal,
      onCalendarCursorChange: setCalendarCursor,
      onDateSelect,
      onViewChange,
      readonly,
      refreshCalendar,
      selectedDate,
      showWeekNumbers,
      view,
    }),
    [
      allJournalDates,
      calendarCursor,
      calendarError,
      calendarLoading,
      eventCountForDate,
      eventDateColor,
      eventDates,
      isJournal,
      onDateSelect,
      onViewChange,
      readonly,
      refreshCalendar,
      selectedDate,
      showWeekNumbers,
      view,
    ],
  );

  return (
    <JournalToolStateContext.Provider value={model}>
      {children}
    </JournalToolStateContext.Provider>
  );
}

export function useJournalToolState(): JournalToolState {
  const state = useContext(JournalToolStateContext);
  if (!state) {
    throw new Error(
      "Journal tool bodies must be rendered inside JournalToolStateProvider",
    );
  }
  return state;
}

export const __test__ = {
  browserLocation,
  JOURNAL_ROUTE_RE,
};
